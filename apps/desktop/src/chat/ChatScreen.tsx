// DK-4: the chat. The container: it owns the connection and the draft, and hands both to the
// presentational list and composer.
import { type DragEvent, useRef, useState } from 'react';
import type { DaemonStatus, LocalChannel } from '../shell.ts';
import { strings } from '../strings.ts';
import { Composer } from './Composer.tsx';
import { isWaiting } from './conversation.ts';
import { MessageList } from './MessageList.tsx';
import { useChat } from './use-chat.ts';
import { useDraft } from './use-draft.ts';

export interface ChatScreenProps {
  daemon: DaemonStatus;
  /** Where the daemon listens; `null` unless it is running. */
  channel: LocalChannel | null;
}

/** Why there is no channel, in the principal's words. */
const withoutChannel = ({ state, reason }: DaemonStatus): string => {
  const { disabled } = strings.chat;
  if (state === 'failing') return disabled.failing;
  if (state === 'stopped')
    return reason === 'not_configured' ? disabled.notConfigured : disabled.stopped;
  return disabled.starting;
};

const carriesFiles = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files');

export function ChatScreen({ daemon, channel }: ChatScreenProps) {
  const chat = useChat(channel);
  const draft = useDraft();
  const [dropping, setDropping] = useState(false);
  /** `dragenter` minus `dragleave`: both also fire for every child the pointer crosses. */
  const dragDepth = useRef(0);

  const disabled = channel === null;
  const connecting = chat.conversation.connection !== 'open';
  const blocked = disabled
    ? withoutChannel(daemon)
    : connecting
      ? strings.chat.disabled.connecting
      : null;

  const submit = () => {
    const text = draft.text.trim();
    if (blocked !== null || (text === '' && draft.attachments.length === 0)) return;
    chat.say(text, draft.attachments);
    draft.clear();
  };

  const endDrag = () => {
    dragDepth.current = 0;
    setDropping(false);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the keyboard's way to attach is the composer's button.
    <section
      className="chat"
      data-offline={disabled || undefined}
      data-dropping={dropping || undefined}
      onDragEnter={(event) => {
        if (disabled || !carriesFiles(event)) return;
        dragDepth.current += 1;
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (disabled || !carriesFiles(event)) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) endDrag();
      }}
      onDragOver={(event) => {
        // Without this the WebView would open the dropped file in place of the window.
        if (carriesFiles(event)) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        endDrag();
        if (!disabled) draft.addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <MessageList
        messages={chat.conversation.messages}
        waiting={isWaiting(chat.conversation)}
        onRetry={chat.retry}
        onPress={chat.press}
      />
      <Composer
        text={draft.text}
        attachments={draft.attachments}
        notice={draft.notice}
        disabled={disabled}
        blocked={blocked}
        onText={draft.setText}
        onFiles={draft.addFiles}
        onRemove={draft.remove}
        onSubmit={submit}
      />
      {dropping && (
        <div className="drop-hint" aria-hidden="true">
          <span>{strings.chat.dropHere}</span>
        </div>
      )}
    </section>
  );
}
