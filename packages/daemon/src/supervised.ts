import type { Readable } from 'node:stream';

// DK-1 AC1 (docs/desktop-prd.md): quitting the app stops the daemon, and no daemon process is
// left running. The app holds the other end of the daemon's stdin, which closes when the app
// goes, however it went: a quit, a crash or a kill. Signals alone would miss the last two.

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
