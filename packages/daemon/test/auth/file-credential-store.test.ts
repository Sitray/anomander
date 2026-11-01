import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Credential } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileCredentialStore } from '../../src/auth/file-credential-store.ts';

// R-27 AC5: the credentials live in one file at `ANOMANDER_AUTH_PATH`, mode 600, written
// atomically and read on every request.
let scratch: string;
let path: string;

const OAUTH: Credential = {
  type: 'oauth',
  access: 'access-secret',
  refresh: 'refresh-secret',
  expires: 1,
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-auth-'));
  path = join(scratch, 'nested', 'auth.json');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the file credential store (R-27 AC5)', () => {
  it('writes the file with mode 600 through a rename, and lists no secrets', async () => {
    const store = createFileCredentialStore(path);
    await store.modify('anthropic', async () => OAUTH);
    // A file someone made readable by others is replaced by a private one on the next write.
    chmodSync(path, 0o644);
    await store.modify('openai', async () => ({ type: 'api_key', key: 'sk-secret' }));

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(scratch, 'nested'))).toEqual(['auth.json']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      anthropic: OAUTH,
      openai: { type: 'api_key', key: 'sk-secret' },
    });
    const listed = await store.list();
    expect(listed).toEqual([
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'openai', type: 'api_key' },
    ]);
    expect(JSON.stringify(listed)).not.toContain('secret');
  });

  it('reads the file on every request, so a login made by another process is used at once', async () => {
    const store = createFileCredentialStore(path);
    expect(await store.read('anthropic')).toBeUndefined();

    await createFileCredentialStore(path).modify('anthropic', async () => OAUTH);

    expect(await store.read('anthropic')).toEqual(OAUTH);
    await store.delete('anthropic');
    expect(await store.list()).toEqual([]);
  });

  it('names an unreadable file without quoting its contents', async () => {
    writeFileSync(join(scratch, 'auth.json'), '{"anthropic": "access-secret', { mode: 0o600 });
    const store = createFileCredentialStore(join(scratch, 'auth.json'));

    const error = await store.list().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(String(error)).toContain('auth.json');
    expect(String(error)).not.toContain('secret');
  });
});
