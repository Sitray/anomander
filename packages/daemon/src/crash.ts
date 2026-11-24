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
