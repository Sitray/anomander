import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';

// R-27 AC5: the model login credentials, in one JSON file keyed by pi-ai provider ID (the same
// shape as pi-ai's own `auth.json`). pi-ai reads and refreshes them through this store.
//
// - The file is read on every `read` and `list`, with no cache, so a login made from a terminal
//   (`pnpm run login`) is used by the running daemon without a restart.
// - Every write goes to a temporary file in the same directory, created with mode 600, flushed and
//   renamed over the file. A reader never sees half a file, and the file is never readable by
//   others, even if it was before.
// - Writes in this process are serialized: each one re-reads the file and changes one provider.
//   There is no lock across processes. The rename keeps the file whole, but if the daemon and a
//   terminal login write at the same instant, the later rename wins and the other write is lost;
//   logging in again repeats it.
// - Nothing here logs, and errors never quote the file: it holds tokens and keys.

/** The file as stored. Entries that are not credentials are kept as they are on every write. */
type Entries = Record<string, unknown>;

const isCredential = (value: unknown): value is Credential =>
  typeof value === 'object' &&
  value !== null &&
  ((value as { type?: unknown }).type === 'oauth' ||
    (value as { type?: unknown }).type === 'api_key');

export const createFileCredentialStore = (path: string): CredentialStore => {
  const readAll = async (): Promise<Entries> => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`cannot read the credential file ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // JSON.parse quotes the text it failed on, so its message is not passed on.
      throw new Error(`the credential file ${path} is not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`the credential file ${path} is not a JSON object`);
    }
    return parsed as Entries;
  };

  const credential = (entries: Entries, providerId: string): Credential | undefined => {
    const entry = Object.hasOwn(entries, providerId) ? entries[providerId] : undefined;
    return isCredential(entry) ? entry : undefined;
  };

  const writeAll = async (entries: Entries): Promise<void> => {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        // The umask can only remove bits; this makes 600 explicit whatever it is.
        await file.chmod(0o600);
        await file.writeFile(`${JSON.stringify(entries, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  };

  // One chain for the whole file: every write rewrites it.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    read: async (providerId: string, options?: AuthOperationOptions) => {
      options?.signal?.throwIfAborted();
      return credential(await readAll(), providerId);
    },
    list: async (options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> => {
      options?.signal?.throwIfAborted();
      return Object.entries(await readAll()).flatMap(([providerId, entry]) =>
        isCredential(entry) ? [{ providerId, type: entry.type }] : [],
      );
    },
    modify: (providerId, fn, options) =>
      serialized(async () => {
        options?.signal?.throwIfAborted();
        const current = credential(await readAll(), providerId);
        const next = await fn(current);
        if (next === undefined) return current;
        // Re-read: `fn` may have taken a while (a token refresh), and another provider may have
        // been written meanwhile by another process.
        await writeAll({ ...(await readAll()), [providerId]: next });
        return next;
      }),
    delete: (providerId, options) =>
      serialized(async () => {
        options?.signal?.throwIfAborted();
        const entries = await readAll();
        if (!Object.hasOwn(entries, providerId)) return;
        delete entries[providerId];
        await writeAll(entries);
      }),
  };
};
