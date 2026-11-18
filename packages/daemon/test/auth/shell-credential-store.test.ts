import type { Credential } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIALS_LINE,
  createShellCredentialStore,
  credentialStoreFor,
  printForShell,
} from '../../src/auth/shell-credential-store.ts';

// DK-5 AC1 (desktop next, S5): under the desktop app the model login lives in the Keychain. The
// daemon gets it at its start and hands every change back to the shell on one line of its output.

const OAUTH: Credential = {
  type: 'oauth',
  access: 'access-secret',
  refresh: 'refresh-secret',
  expires: 1,
};
const KEY: Credential = { type: 'api_key', key: 'sk-secret' };

const store = (initial = '{}') => {
  const sent: unknown[] = [];
  return { sent, store: createShellCredentialStore(initial, (entries) => sent.push(entries)) };
};

describe('the login kept by the shell', () => {
  it('starts with what the shell handed over, and lists no secret', async () => {
    const { store: login } = store(JSON.stringify({ anthropic: OAUTH, note: 'kept' }));

    expect(await login.read('anthropic')).toEqual(OAUTH);
    expect(await login.read('openai')).toBeUndefined();
    const listed = await login.list();
    expect(listed).toEqual([{ providerId: 'anthropic', type: 'oauth' }]);
    expect(JSON.stringify(listed)).not.toContain('secret');
  });

  it('hands the whole set to the shell after each change, before the change answers', async () => {
    const { sent, store: login } = store(JSON.stringify({ anthropic: OAUTH, note: 'kept' }));

    // A refresh: the provider may already have rotated the refresh token.
    const rotated = { ...OAUTH, refresh: 'refresh-rotated' };
    expect(await login.modify('anthropic', async () => rotated)).toEqual(rotated);
    expect(sent).toEqual([{ anthropic: rotated, note: 'kept' }]);

    await login.modify('openai', async () => KEY);
    await login.delete('anthropic');
    expect(sent.slice(1)).toEqual([
      { anthropic: rotated, note: 'kept', openai: KEY },
      { note: 'kept', openai: KEY },
    ]);
    expect(await login.read('anthropic')).toBeUndefined();
  });

  it('hands nothing over when nothing changed', async () => {
    const { sent, store: login } = store(JSON.stringify({ anthropic: OAUTH }));

    expect(await login.modify('anthropic', async () => undefined)).toEqual(OAUTH);
    await login.delete('openai');

    expect(sent).toEqual([]);
  });

  it('makes one change at a time', async () => {
    const { sent, store: login } = store();
    let release: () => void = () => {};
    const slow = login.modify(
      'anthropic',
      () =>
        new Promise<Credential>((resolve) => {
          release = () => resolve(OAUTH);
        }),
    );
    const fast = login.modify('openai', async () => KEY);
    await Promise.resolve();
    expect(sent).toEqual([]);
    release();
    await Promise.all([slow, fast]);

    expect(sent).toEqual([{ anthropic: OAUTH }, { anthropic: OAUTH, openai: KEY }]);
  });

  it('keeps the set as it was when the change fails', async () => {
    const { sent, store: login } = store(JSON.stringify({ anthropic: OAUTH }));

    await expect(
      login.modify('anthropic', async () => {
        throw new Error('the provider refused');
      }),
    ).rejects.toThrow('the provider refused');

    expect(sent).toEqual([]);
    expect(await login.read('anthropic')).toEqual(OAUTH);
  });

  it('refuses what is not a JSON object, without quoting it', () => {
    for (const handed of ['not json sk-secret', '["sk-secret"]', 'null']) {
      expect(() => createShellCredentialStore(handed, () => {})).toThrow(
        'ANOMANDER_AUTH_JSON is not a JSON object',
      );
      try {
        createShellCredentialStore(handed, () => {});
      } catch (error) {
        expect((error as Error).message).not.toContain('sk-secret');
      }
    }
  });
});

describe('the line the shell reads', () => {
  it('is one line, its marker and the set as JSON', () => {
    const written: string[] = [];
    printForShell((text) => written.push(text))({ anthropic: OAUTH });

    expect(written).toEqual([`${CREDENTIALS_LINE}${JSON.stringify({ anthropic: OAUTH })}\n`]);
    expect(CREDENTIALS_LINE).toBe('anomander credentials ');
  });
});

describe('which store the daemon uses', () => {
  it('the shell’s when it handed a login over, the file otherwise', async () => {
    const written: string[] = [];
    const fromShell = credentialStoreFor(
      { authJson: JSON.stringify({ openai: KEY }), authPath: '/nowhere/auth.json' },
      (text) => written.push(text),
    );
    expect(await fromShell.read('openai')).toEqual(KEY);
    await fromShell.delete('openai');
    expect(written).toEqual([`${CREDENTIALS_LINE}{}\n`]);

    const fromFile = credentialStoreFor(
      { authJson: undefined, authPath: '/nowhere/auth.json' },
      () => {},
    );
    expect(await fromFile.read('openai')).toBeUndefined();
  });
});
