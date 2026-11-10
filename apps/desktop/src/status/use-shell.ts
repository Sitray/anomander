// The window's view of the shell (`shell.ts`): the latest snapshot and the commands. Snapshots
// carry no sequence number, so the answer of a command may be older than an event that arrived
// while it was on its way: an event always wins.
import { useCallback, useEffect, useRef, useState } from 'react';
import { type SetupInput, type Snapshot, shell } from '../shell.ts';
import { messageOf } from '../ui/message-of.ts';
import type { Command, CommandError } from './StatusBar.tsx';

export interface Shell {
  /** `null` until the shell answered. */
  snapshot: Snapshot | null;
  /** Why the first snapshot could not be read; the shell's own message. */
  loadError: string | null;
  busy: Command | null;
  commandError: CommandError | null;
  /** Asks for the first snapshot again. */
  reload(): void;
  start(): void;
  stop(): void;
  dismissError(): void;
  /** Saves the setup, which restarts the daemon; rejects as the shell does when it refuses it. */
  saveSetup(input: SetupInput): Promise<Snapshot>;
}

export const useShell = (): Shell => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Command | null>(null);
  const [commandError, setCommandError] = useState<CommandError | null>(null);
  /** How many snapshot events arrived: an answer older than the latest one is dropped. */
  const events = useRef(0);

  const reload = useCallback(() => {
    const seen = events.current;
    setLoadError(null);
    shell.snapshot().then(
      (answer) => {
        if (events.current === seen) setSnapshot(answer);
      },
      (error: unknown) => {
        if (events.current === seen) setLoadError(messageOf(error));
      },
    );
  }, []);

  useEffect(() => {
    let gone = false;
    let unlisten: (() => void) | undefined;
    shell
      .onSnapshot((next) => {
        if (gone) return;
        events.current += 1;
        setSnapshot(next);
        setLoadError(null);
      })
      .then(
        (stop) => {
          // The window went away before the subscription was ready.
          if (gone) stop();
          else unlisten = stop;
        },
        (error: unknown) => {
          if (!gone) setLoadError(messageOf(error));
        },
      );
    reload();
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [reload]);

  const run = useCallback((command: Command) => {
    setBusy(command);
    setCommandError(null);
    (command === 'start' ? shell.startDaemon() : shell.stopDaemon())
      .catch((error: unknown) => setCommandError({ command, message: messageOf(error) }))
      .finally(() => setBusy(null));
  }, []);

  const start = useCallback(() => run('start'), [run]);
  const stop = useCallback(() => run('stop'), [run]);
  const dismissError = useCallback(() => setCommandError(null), []);

  const saveSetup = useCallback(async (input: SetupInput) => {
    const seen = events.current;
    const saved = await shell.saveSetup(input);
    if (events.current === seen) setSnapshot(saved);
    return saved;
  }, []);

  return { snapshot, loadError, busy, commandError, reload, start, stop, dismissError, saveSetup };
};
