// The window: the daemon's status on top, and under it the chat, the setup screen, the
// connections screen, the subscriptions screen, the import of a ledger, the expenses (DK-17)
// or Memoria (DK-18). The container: it
// reads the shell and decides which one is on screen.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatScreen } from './chat/ChatScreen.tsx';
import { ConnectionsScreen } from './connections/ConnectionsScreen.tsx';
import { addWebSearch } from './connections/web-search.ts';
import { ExpensesScreen } from './expenses/ExpensesScreen.tsx';
import { LedgerScreen } from './ledger/LedgerScreen.tsx';
import { SubscriptionsScreen } from './login/SubscriptionsScreen.tsx';
import { MemoryScreen } from './memory/MemoryScreen.tsx';
import { isComplete, SetupScreen } from './setup/SetupScreen.tsx';
import { shell as native, type SetupInput } from './shell.ts';
import { useSetupShortcut } from './shortcuts.ts';
import { ErrorBlock, StatusBar } from './status/StatusBar.tsx';
import { useShell } from './status/use-shell.ts';
import { strings } from './strings.ts';

export function App() {
  const shell = useShell();
  const { snapshot } = shell;
  /** The screen over the chat, when there is one. */
  const [open, setOpen] = useState<
    'setup' | 'connections' | 'subscriptions' | 'ledger' | 'expenses' | 'memory' | null
  >(null);
  const main = useRef<HTMLElement>(null);

  // DK-5 AC1: nothing works until the setup is complete, so it opens by itself, once each time
  // the daemon turns out not to be configured. Closing it is the principal's choice.
  const notConfigured = snapshot?.daemon.reason === 'not_configured';
  useEffect(() => {
    if (notConfigured) setOpen('setup');
  }, [notConfigured]);

  // A file dropped outside the chat would otherwise replace the window with that file.
  useEffect(() => {
    const ignore = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', ignore);
    window.addEventListener('drop', ignore);
    return () => {
      window.removeEventListener('dragover', ignore);
      window.removeEventListener('drop', ignore);
    };
  }, []);

  const close = useCallback(() => {
    setOpen(null);
    // Back to where the principal writes; the chat was only hidden, so it is as they left it.
    requestAnimationFrame(() => main.current?.querySelector('textarea')?.focus());
  }, []);

  // DK-20: Cmd+, (Ctrl+, on Windows) as the status area's button.
  useSetupShortcut(open === 'setup' || open === 'ledger' ? close : () => setOpen('setup'));

  const { saveSetup } = shell;
  const save = useCallback(
    async (input: SetupInput) => {
      const { setup } = await saveSetup(input);
      // Saved and able to start, with or without Telegram (T13): back to the chat. Otherwise the
      // screen says what is missing.
      if (isComplete(setup)) close();
      return setup;
    },
    [saveSetup, close],
  );

  const { connections, saveConnection } = shell;
  // DK-11 AC11: from the first setup and from the chat; a server already named so is kept.
  const onAddWebSearch = useCallback(
    () => addWebSearch({ connections, saveConnection }),
    [connections, saveConnection],
  );

  // B48: the shell shows the window again (closing it only hides it); the chat then shows what
  // the daemon keeps now. Subscribed as `useShell` subscribes "Detener tarea".
  // DK-18: a forget in Memoria erased the turns of the stored conversation that said it; the chat
  // follows it as it follows the window shown again. DK-17 AC6: and so it follows a row's
  // "Corregir" or "Deshacer" in Gastos, stored as a press in the chat with its reply.
  const forgottenListeners = useRef(new Set<() => void>());
  const onForgotten = useCallback(() => {
    for (const listener of forgottenListeners.current) listener();
  }, []);
  const subscribeShown = useCallback((shown: () => void) => {
    forgottenListeners.current.add(shown);
    let gone = false;
    let unlisten: (() => void) | undefined;
    native.onChatShown(shown).then(
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
      forgottenListeners.current.delete(shown);
    };
  }, []);

  return (
    <div className="window">
      <StatusBar
        daemon={snapshot?.daemon ?? null}
        busy={shell.busy}
        commandError={shell.commandError}
        setupOpen={open === 'setup' || open === 'ledger'}
        connectionsOpen={open === 'connections'}
        subscriptionsOpen={open === 'subscriptions'}
        expensesOpen={open === 'expenses'}
        onStart={shell.start}
        onStop={shell.stop}
        onToggleSetup={open === 'setup' || open === 'ledger' ? close : () => setOpen('setup')}
        onToggleConnections={open === 'connections' ? close : () => setOpen('connections')}
        onToggleSubscriptions={open === 'subscriptions' ? close : () => setOpen('subscriptions')}
        onToggleExpenses={open === 'expenses' ? close : () => setOpen('expenses')}
        memoryOpen={open === 'memory'}
        onToggleMemory={open === 'memory' ? close : () => setOpen('memory')}
        onDismissError={shell.dismissError}
      />
      <main className="main" ref={main}>
        {snapshot === null ? (
          shell.loadError !== null && (
            <div className="unreachable" role="alert">
              <p>{strings.status.shellUnreachable}</p>
              <ErrorBlock label={strings.status.errorDetail}>{shell.loadError}</ErrorBlock>
              <button type="button" className="button primary" onClick={shell.reload}>
                {strings.status.retry}
              </button>
            </div>
          )
        ) : (
          <>
            {/* Hidden, not unmounted: the conversation lives in memory only (DK-4). */}
            <div className="view" hidden={open !== null}>
              <ChatScreen
                daemon={snapshot.daemon}
                channel={snapshot.channel}
                onThinking={shell.setThinking}
                onReply={shell.notifyReply}
                onCaptureScreen={shell.captureScreen}
                onPerformAction={shell.performAction}
                onReveal={shell.reveal}
                onTaskRunning={shell.setTaskRunning}
                subscribeStop={shell.onStopTask}
                subscribeShown={subscribeShown}
                model={snapshot.setup.model}
                onStart={shell.start}
                onAddWebSearch={onAddWebSearch}
              />
            </div>
            {open === 'setup' && (
              <div className="view">
                <SetupScreen
                  setup={snapshot.setup}
                  onSave={save}
                  onClose={close}
                  onOpenLedger={() => setOpen('ledger')}
                  onOpenSubscriptions={() => setOpen('subscriptions')}
                  onAddWebSearch={onAddWebSearch}
                />
              </div>
            )}
            {open === 'subscriptions' && (
              <div className="view">
                <SubscriptionsScreen
                  load={shell.subscriptions}
                  onConnect={shell.connectSubscription}
                  onAnswer={shell.answerLogin}
                  onDisconnect={shell.disconnectSubscription}
                  subscribeSteps={shell.onLoginStep}
                  onClose={close}
                />
              </div>
            )}
            {open === 'memory' && (
              <div className="view">
                <MemoryScreen
                  channel={snapshot.channel}
                  onClose={close}
                  onForgotten={onForgotten}
                />
              </div>
            )}
            {open === 'ledger' && (
              <div className="view">
                <LedgerScreen onImport={shell.importLedger} onClose={close} />
              </div>
            )}
            {open === 'expenses' && (
              <div className="view">
                <ExpensesScreen
                  channel={snapshot.channel}
                  onClose={close}
                  onAmended={onForgotten}
                  onCorrecting={close}
                />
              </div>
            )}
            {open === 'connections' && (
              <div className="view">
                <ConnectionsScreen
                  load={shell.connections}
                  onSave={shell.saveConnection}
                  onRemove={shell.removeConnection}
                  onConnectOAuth={shell.connectOAuth}
                  onForgetOAuth={shell.forgetOAuth}
                  onClose={close}
                />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
