import type { Readable } from 'node:stream';
import { type AuthContext, defaultProviderAuthContext } from '@earendil-works/pi-ai';

// DK-1 AC1 (docs/desktop-prd.md): quitting the app stops the daemon, and no daemon process is
// left running. The app holds the other end of the daemon's stdin, which closes when the app
// goes, however it went: a quit, a crash or a kill. Signals alone would miss the last two.
//
// DK-5 AC2: before that, the app writes the secrets on stdin as one JSON line, so they are never
// in the daemon's environment, which `ps eww` shows to every process of the principal.

/** Whether the daemon was started by a supervisor that asked for this: `ANOMANDER_STOP_WITH_PARENT=1`. */
export const stopsWithParent = (env: Record<string, string | undefined>): boolean =>
  env.ANOMANDER_STOP_WITH_PARENT === '1';

/** Calls `stop` once, when `stdin` ends or closes. Whatever arrives on it is discarded. */
export const stopWhenParentGoes = (stdin: Readable, stop: () => void): void => {
  let gone = false;
  const onGone = (): void => {
    if (gone) return;
    gone = true;
    stop();
  };
  stdin.once('end', onGone);
  stdin.once('close', onGone);
  stdin.resume();
};

/** Whether the secrets come on stdin: `ANOMANDER_SECRETS_ON_STDIN=1`, which only the app sets. */
export const secretsOnStdin = (env: Record<string, string | undefined>): boolean =>
  env.ANOMANDER_SECRETS_ON_STDIN === '1';

/** By variable name, as the environment would hold them. */
export type Handover = Record<string, string>;

/** How long the app has to write the line once the daemon asks for it. */
const HANDOVER_TIMEOUT_MS = 10_000;

const parseHandover = (line: string): Handover => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // The parser's message quotes the line.
    throw new Error('the secrets on stdin are not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the secrets on stdin are not a JSON object');
  }
  if (Object.values(parsed).some((value) => typeof value !== 'string')) {
    throw new Error('a secret on stdin is not a string');
  }
  return parsed as Handover;
};

/**
 * Reads the first line of `stdin`: the secrets the app hands over. Rejects, never quoting the
 * line, when it is not a JSON object of strings or when `stdin` ends, closes or stays silent for
 * `timeoutMs` before it. Whatever follows the line is left on the stream, paused, for
 * `stopWhenParentGoes`, which discards it.
 */
export const readHandover = (
  stdin: Readable,
  timeoutMs: number = HANDOVER_TIMEOUT_MS,
): Promise<Handover> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const settle = (outcome: () => Handover): void => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('close', onEnd);
      stdin.off('error', onError);
      stdin.pause();
      try {
        resolve(outcome());
      } catch (error) {
        reject(error);
      }
    };
    const fail = (message: string) => () => {
      throw new Error(message);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) {
        chunks.push(bytes);
        return;
      }
      chunks.push(bytes.subarray(0, newline));
      settle(() => parseHandover(Buffer.concat(chunks).toString('utf8')));
    };
    const onEnd = (): void => settle(fail('stdin ended before the secrets arrived'));
    const onError = (): void => settle(fail('stdin failed before the secrets arrived'));
    const timer = setTimeout(
      () => settle(fail(`the secrets did not arrive on stdin within ${timeoutMs} ms`)),
      timeoutMs,
    );
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('close', onEnd);
    stdin.once('error', onError);
  });

/**
 * pi-ai's view of the environment, with the handed secrets first (DK-5 AC2), so a provider key
 * handed over is found as if it were in `env`. Never copies one into `process.env`. A blank value
 * counts as unset, as in pi-ai's own `defaultProviderAuthContext`.
 */
export const handedAuthContext = (
  handed: Handover,
  env: Record<string, string | undefined>,
): AuthContext => {
  const fromPiAi = defaultProviderAuthContext();
  return {
    env: async (name) => {
      const value = Object.hasOwn(handed, name) ? handed[name] : env[name];
      return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    },
    fileExists: (path) => fromPiAi.fileExists(path),
  };
};
