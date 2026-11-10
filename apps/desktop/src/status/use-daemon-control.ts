// Start and stop from the window (DK-6 AC2 has the same in the menu bar). The new state arrives
// as a snapshot; this only tracks the command itself.
import { useCallback, useState } from 'react';
import { shell } from '../shell.ts';
import { strings } from '../strings.ts';

export interface DaemonControl {
  busy: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
}

export const useDaemonControl = (): DaemonControl => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback((command: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    command()
      .catch(() => setError(failure))
      .finally(() => setBusy(false));
  }, []);

  const start = useCallback(() => run(shell.startDaemon, strings.startFailed), [run]);
  const stop = useCallback(() => run(shell.stopDaemon, strings.stopFailed), [run]);

  return { busy, error, start, stop };
};
