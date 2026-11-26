import { format } from 'node:util';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { rememberingLogins } from '../../src/auth/remembering-logins.ts';
import { scrub } from '../../src/scrubbing-logger.ts';
import { createSecretList } from '../../src/secrets-to-scrub.ts';

// B51: a failed refresh's error quoting new tokens (the verifier's probes for S2).
const NEW_ACCESS = 'ya29.NEW-access-0123456789';
const NEW_REFRESH = '1//NEW-refresh-0123456789';
const NEW_ID = 'eyJ.NEW-id-0123456789';

let list = createSecretList();
/** A store whose `modify` runs `fn` as pi-ai's refresh does, under its lock. */
const failingStore = () =>
  rememberingLogins(
    {
      read: async () => undefined,
      list: async () => [],
      modify: async (
        _id: string,
        fn: (current: Credential | undefined) => Promise<Credential | undefined>,
      ) => fn(undefined),
      delete: async () => {},
    } as unknown as CredentialStore,
    (kind, value) => list.acquire(kind, value),
  );

describe('verifier S2c', () => {
  it('a refresh error whose cause quotes a token response scrubs every token from the line logged later', async () => {
    list = createSecretList();
    const body = JSON.stringify({
      access_token: NEW_ACCESS,
      refresh_token: NEW_REFRESH,
      id_token: NEW_ID,
      expires_in: 3599,
    });
    const thrown = new Error('OAuth refresh failed for openai-codex', {
      cause: new Error(`could not store the token response: ${body}`),
    });
    const store = failingStore();
    await expect(
      store.modify('openai-codex', async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    const line = scrub(format('Model call failed', { error: thrown }), list.current());
    expect(line).not.toContain(NEW_ACCESS);
    expect(line).not.toContain(NEW_REFRESH);
    expect(line).not.toContain(NEW_ID);
    expect(line).toContain('[secret]');
  });

  it('a pi-ai login quoted with escapes inside a message, deep in an AggregateError', async () => {
    list = createSecretList();
    const login = JSON.stringify({
      type: 'oauth',
      access: 'acc"ess-0123456789',
      refresh: 'ref\\resh-0123456789',
      expires: 1,
    });
    const thrown = new AggregateError([new Error(`bad login ${login}`)], 'all failed');
    await expect(
      failingStore().modify('x', async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(list.current()).toEqual(
      expect.arrayContaining(['acc"ess-0123456789', 'ref\\resh-0123456789']),
    );
  });

  it('a non-Error string thrown is read too, and a failure quoting no token adds nothing', async () => {
    list = createSecretList();
    await expect(
      failingStore().modify('x', async () => {
        throw `{"access_token":"${NEW_ACCESS}"}`;
      }),
    ).rejects.toBeDefined();
    expect(list.current()).toEqual([NEW_ACCESS]);
    list = createSecretList();
    await expect(
      failingStore().modify('x', async () => {
        throw new Error(
          '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
        );
      }),
    ).rejects.toBeDefined();
    expect(list.current()).toEqual([]);
  });

  it('a circular cause does not hang', async () => {
    list = createSecretList();
    const a = new Error('a "refresh_token":"circular-0123456789"');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    await expect(
      failingStore().modify('x', async () => {
        throw a;
      }),
    ).rejects.toBe(a);
    expect(list.current()).toEqual(['circular-0123456789']);
  });
});
