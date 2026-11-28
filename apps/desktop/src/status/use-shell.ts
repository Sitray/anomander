// The window's view of the shell (`shell.ts`): the latest snapshot and the commands. Snapshots
// carry no sequence number, so the answer of a command may be older than an event that arrived
// while it was on its way: an event always wins.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type LoginStep,
  type NotificationMode,
  type SetupInput,
  type Snapshot,
  shell,
} from '../shell.ts';
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
  /** DK-22: saves what the notifications show; rejects when it could not. */
  setNotifications(mode: NotificationMode): Promise<Snapshot>;
  /** `shell.connections`, `saveConnection` and `removeConnection`, as they are: the screen says why one failed. */
  connections: typeof shell.connections;
  saveConnection: typeof shell.saveConnection;
  removeConnection: typeof shell.removeConnection;
  /** `shell.importLedger`, as it is: the screen says why one failed. */
  importLedger: typeof shell.importLedger;
  /** `shell.connectOAuth` and `forgetOAuth`, as they are: the screen says why one failed. */
  connectOAuth: typeof shell.connectOAuth;
  forgetOAuth: typeof shell.forgetOAuth;
  /** DK-15: `shell.subscriptions`, `connectSubscription`, `answerLogin` and `disconnectSubscription`, as they are. */
  subscriptions: typeof shell.subscriptions;
  connectSubscription: typeof shell.connectSubscription;
  answerLogin: typeof shell.answerLogin;
  disconnectSubscription: typeof shell.disconnectSubscription;
  /** Subscribes `handler` to the steps of a running login; answers how to unsubscribe. */
  onLoginStep(handler: (step: LoginStep) => void): () => void;
  /** Tells the menu bar whether the chat waits for an answer; a failure only loses that sign. */
  setThinking(thinking: boolean): void;
  /** Hands an answer to the shell to notify it; a failure only loses the notification. */
  notifyReply(text: string): void;
  /** `shell.captureScreen`, as it is: the chat says why a capture failed. */
  captureScreen: typeof shell.captureScreen;
  /** `shell.performAction`, as it is. */
  performAction: typeof shell.performAction;
  /** Brings the app back; a failure leaves it in the menu bar, where "Abrir chat" does the same. */
  reveal(): void;
  /** Tells the menu bar whether a task goes by itself; a failure only loses its "Detener tarea". */
  setTaskRunning(running: boolean): void;
  /** Subscribes `stop` to the menu bar's "Detener tarea"; answers how to unsubscribe. */
  onStopTask(stop: () => void): () => void;
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

  const setNotifications = useCallback(async (mode: NotificationMode) => {
    const seen = events.current;
    const saved = await shell.setNotifications(mode);
    // B75: an event that arrived meanwhile may have been read before the save, so it wins but
    // for the mode, which only this command changes, and the setting asks one at a time. An
    // absent mode is `content`.
    const notifications = saved.setup.notifications ?? 'content';
    setSnapshot((current) =>
      events.current === seen || current === null
        ? saved
        : { ...current, setup: { ...current.setup, notifications } },
    );
    return saved;
  }, []);

  const setThinking = useCallback((thinking: boolean) => {
    shell.setThinking(thinking).catch(() => {});
  }, []);

  const notifyReply = useCallback((text: string) => {
    shell.notifyReply(text).catch(() => {});
  }, []);

  const reveal = useCallback(() => {
    shell.reveal().catch(() => {});
  }, []);

  const setTaskRunning = useCallback((running: boolean) => {
    shell.setTaskRunning(running).catch(() => {});
  }, []);

  const onStopTask = useCallback((stop: () => void) => {
    let gone = false;
    let unlisten: (() => void) | undefined;
    shell.onStopTask(stop).then(
      (off) => {
        // The chat went away before the subscription was ready.
        if (gone) off();
        else unlisten = off;
      },
      () => {},
    );
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  const onLoginStep = useCallback((handler: (step: LoginStep) => void) => {
    let gone = false;
    let unlisten: (() => void) | undefined;
    shell.onLoginStep(handler).then(
      (off) => {
        // The screen went away before the subscription was ready.
        if (gone) off();
        else unlisten = off;
      },
      () => {},
    );
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  return {
    snapshot,
    loadError,
    busy,
    commandError,
    reload,
    start,
    stop,
    dismissError,
    saveSetup,
    setNotifications,
    connections: shell.connections,
    saveConnection: shell.saveConnection,
    removeConnection: shell.removeConnection,
    importLedger: shell.importLedger,
    connectOAuth: shell.connectOAuth,
    forgetOAuth: shell.forgetOAuth,
    subscriptions: shell.subscriptions,
    connectSubscription: shell.connectSubscription,
    answerLogin: shell.answerLogin,
    disconnectSubscription: shell.disconnectSubscription,
    onLoginStep,
    setThinking,
    notifyReply,
    captureScreen: shell.captureScreen,
    performAction: shell.performAction,
    reveal,
    setTaskRunning,
    onStopTask,
  };
};
