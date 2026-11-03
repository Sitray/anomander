import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Sign in with ChatGPT identifies each installation by a UUID that must stay the same on every
// login (pi-ai's `LoginOptions.getDeviceId`). It is kept next to the credential file, as
// `<ANOMANDER_AUTH_PATH>.device-id`, created on first use. It is not a secret.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createDeviceId =
  (authPath: string): (() => string) =>
  () => {
    const path = `${authPath}.device-id`;
    try {
      const stored = readFileSync(path, 'utf8').trim();
      if (UUID.test(stored)) return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const id = randomUUID();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${id}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
    return id;
  };
