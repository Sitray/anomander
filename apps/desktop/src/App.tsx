// The window: the status always on top, then the chat or the setup screen. This container wires
// the hooks (the shell's snapshot, the chat's socket, the draft) to presentational screens.
import { useEffect, useState } from 'react';
import { ChatScreen } from './chat/ChatScreen.tsx';
import { useChat } from './chat/use-chat.ts';
import { useDraft } from './chat/use-draft.ts';
import { SetupScreen } from './setup/SetupScreen.tsx';
import { type SetupInput, type Snapshot, shell } from './shell.ts';
import { StatusBar } from './status/StatusBar.tsx';
import { useDaemonControl } from './status/use-daemon-control.ts';
import { useShell } from './status/use-shell.ts';
import { strings } from './strings.ts';

type View = 'chat' | 'setup';

/** Why the composer cannot be used, from the daemon's state; `null` when it can. */
const composerReason = (snapshot: Snapshot): string | null => {
  if (snapshot.channel !== null) return null;
  return snapshot.daemon.state === 'starting'
    ? strings.noChannel.starting
    : strings.noChannel.stopped;
};

/** A dropped file the chat did not catch must not navigate the window away. */
const useNoStrayDrops = () => {
  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);
};

/** DK-4 AC3: a URL button opens in the browser, away from the app's window. */
const openUrl = (url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

export const App = () => {
  const { snapshot, unavailable, accept } = useShell();
  const chat = useChat(snapshot?.channel ?? null);
  const draft = useDraft(chat);
  const daemon = useDaemonControl();
  const [view, setView] = useState<View>('chat');
  const reason = snapshot?.daemon.reason ?? null;
  const [seenReason, setSeenReason] = useState(reason);
  useNoStrayDrops();

  // DK-5 AC1: with no setup yet, the setup screen opens by itself, before the chat ever shows.
  if (reason !== seenReason) {
    setSeenReason(reason);
    if (reason === 'not_configured') setView('setup');
  }

  if (snapshot === null) {
    return (
      <main className="splash" aria-busy={!unavailable}>
        <p>{unavailable ? strings.shellUnavailable : strings.loading}</p>
      </main>
    );
  }

  const save = async (input: SetupInput): Promise<boolean> => {
    try {
      const next = await shell.saveSetup(input);
      accept(next);
      setView(next.daemon.reason === 'not_configured' ? 'setup' : 'chat');
      return true;
    } catch {
      return false;
    }
  };

  const canSend = chat.connection === 'open';
  const disabledReason = composerReason(snapshot);

  return (
    <div className="window">
      <StatusBar
        daemon={snapshot.daemon}
        busy={daemon.busy}
        error={daemon.error}
        inSetup={view === 'setup'}
        onStart={daemon.start}
        onStop={daemon.stop}
        onOpenSetup={() => setView('setup')}
      />
      {view === 'setup' ? (
        <SetupScreen setup={snapshot.setup} onSave={save} onBack={() => setView('chat')} />
      ) : (
        <ChatScreen
          messages={chat.messages}
          canSend={canSend}
          onPress={chat.press}
          onRetry={chat.retry}
          onOpenUrl={openUrl}
          text={draft.text}
          attachments={draft.attachments}
          notice={draft.notice}
          tooLong={draft.tooLong}
          disabledReason={disabledReason}
          waitingReason={disabledReason === null && !canSend ? strings.noChannel.connecting : null}
          onTextChange={draft.setText}
          onAddFiles={draft.addFiles}
          onRemoveAttachment={draft.removeAttachment}
          onSubmit={draft.submit}
        />
      )}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {chat.announcement}
      </div>
    </div>
  );
};
