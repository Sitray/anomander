// The shell's view of things (daemon, channel, setup), kept current from its events.
import { useEffect, useState } from 'react';
import { type Snapshot, shell } from '../shell.ts';

export interface ShellView {
  /** `null` until the shell first answers. */
  snapshot: Snapshot | null;
  /** The shell did not answer at all, as when the window runs outside the app. */
  unavailable: boolean;
  /** Takes a snapshot the shell returned from a command, such as saving the setup. */
  accept: (snapshot: Snapshot) => void;
}

export const useShell = (): ShellView => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    shell
      .onSnapshot((next) => {
        if (active) setSnapshot(next);
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    shell
      .snapshot()
      // An event that arrived first is newer than this answer.
      .then((first) => {
        if (active) setSnapshot((current) => current ?? first);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return { snapshot, unavailable, accept: setSnapshot };
};
