import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { createFileCredentialStore } from './file-credential-store.ts';

// DK-5 AC1 (desktop next, S5): under the desktop app the model login lives in the Keychain, never
// in a file. The app hands it over at the daemon's start in `ANOMANDER_AUTH_JSON` (the shape of
// `auth.json`), and the daemon keeps it in memory. Every change (a login, a logout, a token
// refresh) prints the whole set on one line of the daemon's output, which the app reads, never
// echoes, and stores before it reads the next line.
//
// The line is printed before the change answers, so pi-ai uses a rotated token only once it is
// on its way to the shell. A daemon killed between the refresh and the print loses that token,
// and the principal logs in again. Nothing here logs, and errors never quote the set.

/** The start of the line the shell reads: `launch.rs` and `supervisor.rs` know it too. */
export const CREDENTIALS_LINE = 'anomander credentials ';

/** The set as stored. Entries that are not credentials are kept as they are on every change. */
type Entries = Record<string, unknown>;

const isCredential = (value: unknown): value is Credential =>
  typeof value === 'object' &&
  value !== null &&
  ((value as { type?: unknown }).type === 'oauth' ||
    (value as { type?: unknown }).type === 'api_key');

const parse = (handed: string): Entries => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(handed);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // JSON.parse quotes the text it failed on, so its message is not passed on.
    throw new Error('ANOMANDER_AUTH_JSON is not a JSON object');
  }
  return parsed as Entries;
};

/** Prints the set for the shell, on one line: `JSON.stringify` writes no line break. */
export const printForShell =
  (write: (text: string) => void = (text) => process.stdout.write(text)) =>
  (entries: Entries): void =>
    write(`${CREDENTIALS_LINE}${JSON.stringify(entries)}\n`);

export const createShellCredentialStore = (
  handed: string,
  send: (entries: Entries) => void,
): CredentialStore => {
  let entries = parse(handed);
  const credential = (providerId: string): Credential | undefined => {
    const entry = Object.hasOwn(entries, providerId) ? entries[providerId] : undefined;
    return isCredential(entry) ? entry : undefined;
  };
  const change = (next: Entries): void => {
    send(next);
    entries = next;
  };

  // One change at a time, as the file store does: each one sends the whole set.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    read: async (providerId, options) => {
      options?.signal?.throwIfAborted();
      return credential(providerId);
    },
    list: async (options): Promise<readonly CredentialInfo[]> => {
      options?.signal?.throwIfAborted();
      return Object.entries(entries).flatMap(([providerId, entry]) =>
        isCredential(entry) ? [{ providerId, type: entry.type }] : [],
      );
    },
    modify: (providerId, fn, options) =>
      serialized(async () => {
        options?.signal?.throwIfAborted();
        const current = credential(providerId);
        const next = await fn(current);
        if (next === undefined) return current;
        change({ ...entries, [providerId]: next });
        return next;
      }),
    delete: (providerId, options) =>
      serialized(async () => {
        options?.signal?.throwIfAborted();
        if (!Object.hasOwn(entries, providerId)) return;
        const { [providerId]: _gone, ...rest } = entries;
        change(rest);
      }),
  };
};

/**
 * The store the daemon uses: the shell's when the desktop app handed a login over, otherwise the
 * file at `ANOMANDER_AUTH_PATH` (Docker, a server, `pnpm run login`).
 */
export const credentialStoreFor = (
  config: { authJson: string | undefined; authPath: string },
  write?: (text: string) => void,
): CredentialStore =>
  config.authJson === undefined
    ? createFileCredentialStore(config.authPath)
    : createShellCredentialStore(config.authJson, printForShell(write));
