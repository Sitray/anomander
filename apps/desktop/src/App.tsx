// The window: the daemon's status on top, and under it the chat or the setup screen. The
// container: it reads the shell and decides which of the two is on screen.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatScreen } from './chat/ChatScreen.tsx';
import { SetupScreen } from './setup/SetupScreen.tsx';
import type { SetupInput } from './shell.ts';
import { ErrorBlock, StatusBar } from './status/StatusBar.tsx';
import { useShell } from './status/use-shell.ts';
import { strings } from './strings.ts';

export function App() {
  const shell = useShell();
  const { snapshot } = shell;
  const [setupOpen, setSetupOpen] = useState(false);
  const main = useRef<HTMLElement>(null);

  // DK-5 AC1: nothing works until the setup is complete, so it opens by itself, once each time
  // the daemon turns out not to be configured. Closing it is the principal's choice.
  const notConfigured = snapshot?.daemon.reason === 'not_configured';
  useEffect(() => {
    if (notConfigured) setSetupOpen(true);
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

  const closeSetup = useCallback(() => {
    setSetupOpen(false);
    // Back to where the principal writes; the chat was only hidden, so it is as they left it.
    requestAnimationFrame(() => main.current?.querySelector('textarea')?.focus());
  }, []);

  const { saveSetup } = shell;
  const save = useCallback(
    async (input: SetupInput) => {
      const { setup } = await saveSetup(input);
      // Saved and able to start: back to the chat. Otherwise the screen says what is missing.
      if (setup.hasTelegramBotToken && setup.principalChatId !== null) closeSetup();
      return setup;
    },
    [saveSetup, closeSetup],
  );

  return (
    <div className="window">
      <StatusBar
        daemon={snapshot?.daemon ?? null}
        busy={shell.busy}
        commandError={shell.commandError}
        setupOpen={setupOpen}
        onStart={shell.start}
        onStop={shell.stop}
        onToggleSetup={setupOpen ? closeSetup : () => setSetupOpen(true)}
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
            <div className="view" hidden={setupOpen}>
              <ChatScreen
                daemon={snapshot.daemon}
                channel={snapshot.channel}
                onThinking={shell.setThinking}
                onReply={shell.notifyReply}
              />
            </div>
            {setupOpen && (
              <div className="view">
                <SetupScreen setup={snapshot.setup} onSave={save} onClose={closeSetup} />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
