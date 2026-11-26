// B8: an error nobody caught would reach Node's own handler, which prints it raw, secrets and
// all, to the log a Docker install keeps. It is written through the daemon's scrubbed log instead,
// and the daemon still stops with a failure, as Node would stop it.
import { type ExitCode, exitCodes } from '@anomander/protocol';
import type { TelegramLogger } from '@anomander/telegram';

/** Where the crashes are told: `process`. */
export interface CrashSource {
  on(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (error: unknown) => void,
  ): unknown;
}

/** Where the log goes: `process.stdout` and `process.stderr`. */
export interface Drainable {
  write(chunk: string, done: (error?: Error | null) => void): boolean;
}

/** How long `exitOnceWritten` waits for its streams and its halt before it exits anyway. */
export const DRAIN_LIMIT_MS = 5_000;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

/**
 * `exit`, called once whatever was written to `streams` is out (B45): a pipe on macOS or Windows
 * is written later, and `process.exit` drops what still waits, the crash line among it. A stream
 * that never drains holds the exit `limitMs` at most. Only the first code counts.
 *
 * B51: `halt` is called at once, before the wait, so the daemon takes no new event while its log
 * drains. One that throws does not hold the exit. B84: when `halt` returns a promise, the exit
 * also waits for it to settle, fulfilled or not, under the same `limitMs`: the Telegram bot's
 * last `getUpdates`, which tells Telegram what was handled, reaches it before the process is
 * gone, and a halt that hangs, or a network that does, still exits on time.
 */
export const exitOnceWritten = (
  streams: readonly Drainable[],
  exit: (code: ExitCode) => void,
  limitMs: number = DRAIN_LIMIT_MS,
  halt: () => unknown = () => {},
): ((code: ExitCode) => void) => {
  let leaving = false;
  return (code) => {
    if (leaving) return;
    leaving = true;
    let halting: unknown;
    try {
      halting = halt();
    } catch {
      // The exit matters more: the daemon is leaving anyway.
    }
    const waitsForHalt = isThenable(halting);
    let pending = streams.length + (waitsForHalt ? 1 : 0);
    let gone = false;
    const leave = (): void => {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      exit(code);
    };
    const done = (): void => {
      pending -= 1;
      if (pending === 0) leave();
    };
    const timer = setTimeout(leave, limitMs);
    if (pending === 0) leave();
    if (waitsForHalt) (halting as PromiseLike<unknown>).then(done, done);
    // An empty write is done once every write queued before it is.
    for (const stream of streams) stream.write('', done);
  };
};

/** Writes every uncaught exception and unhandled rejection to `log`, then calls `exit`. */
export const reportCrashes = (
  source: CrashSource,
  log: Pick<TelegramLogger, 'error'>,
  exit: (code: ExitCode) => void,
): void => {
  const report = (what: string) => (error: unknown) => {
    log.error(`anomander daemon crashed: ${what}`, { error });
    exit(exitCodes.failed);
  };
  source.on('uncaughtException', report('uncaught exception'));
  source.on('unhandledRejection', report('unhandled rejection'));
};
