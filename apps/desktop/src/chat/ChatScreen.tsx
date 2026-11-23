// DK-4: the chat. The container: it owns the connection and the draft, and hands both to the
// presentational list and composer.
import type { ComputerAction } from '@anomander/protocol';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonStatus, LocalChannel } from '../shell.ts';
import { strings } from '../strings.ts';
import { Composer } from './Composer.tsx';
import { isWaiting } from './conversation.ts';
import { emptyStateFor, MessageList } from './MessageList.tsx';
import { useChat } from './use-chat.ts';
import { useDraft } from './use-draft.ts';

export interface ChatScreenProps {
  daemon: DaemonStatus;
  /** Where the daemon listens; `null` unless it is running. */
  channel: LocalChannel | null;
  /** Called whenever the chat starts or stops waiting for an answer, and with `false` on leaving. */
  onThinking?: (thinking: boolean) => void;
  /** Called with the text of every answer. */
  onReply?: (text: string) => void;
  /** Takes a JPEG of the screen; rejects with `screen_permission` when macOS does not allow it. */
  onCaptureScreen?: (keepHidden?: boolean) => Promise<ArrayBuffer>;
  /**
   * DK-10: performs one action on the computer and answers with a JPEG of the screen after it;
   * `permitted` when the principal allowed it (`shell.performAction`).
   */
  onPerformAction?: (
    action: ComputerAction,
    keepHidden?: boolean,
    permitted?: boolean,
  ) => Promise<ArrayBuffer>;
  /** Brings the app back after a capture or an action that kept it out of the way. */
  onReveal?: () => void;
  /** Called whenever a task on the computer starts or stops going by itself. */
  onTaskRunning?: (running: boolean) => void;
  /** Subscribes `stop` to the menu bar's "Detener tarea"; answers how to unsubscribe. */
  subscribeStop?: (stop: () => void) => () => void;
  /** The model the daemon answers with (S2); `null` or absent when none is set. */
  model?: string | null;
  /** S5: starts the daemon, offered by the empty chat while it is stopped. */
  onStart?: () => void;
  /**
   * DK-11 AC13: adds the web search connection; `true` when saved, `false` when it was already
   * there. Absent where the window cannot add one: the chat then only says it is missing.
   */
  onAddWebSearch?: () => Promise<boolean>;
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

export function ChatScreen(props: ChatScreenProps) {
  const { daemon, channel, onThinking, onReply, onCaptureScreen, onPerformAction } = props;
  const { onReveal, onTaskRunning, subscribeStop, model = null, onAddWebSearch } = props;
  const draft = useDraft();
  const computer = useMemo(
    () =>
      onCaptureScreen === undefined || onPerformAction === undefined
        ? undefined
        : {
            // A task keeps the app out of the way from its first capture until it rests.
            capture: () => onCaptureScreen(true),
            perform: (action: ComputerAction, permitted: boolean) =>
              onPerformAction(action, true, permitted),
            reveal: () => onReveal?.(),
          },
    [onCaptureScreen, onPerformAction, onReveal],
  );
  const chat = useChat(channel, {
    ...(onReply === undefined ? {} : { onReply }),
    ...(computer === undefined ? {} : { computer }),
    // DK-9: a look does not keep the app out of the way.
    ...(onCaptureScreen === undefined ? {} : { look: () => onCaptureScreen() }),
    onProblem: draft.warn,
    ...(onAddWebSearch === undefined ? {} : { addWebSearch: onAddWebSearch }),
  });
  const [dropping, setDropping] = useState(false);
  /** `dragenter` minus `dragleave`: both also fire for every child the pointer crosses. */
  const dragDepth = useRef(0);

  const waiting = isWaiting(chat.conversation);
  useEffect(() => onThinking?.(waiting), [waiting, onThinking]);
  useEffect(() => () => onThinking?.(false), [onThinking]);

  const { running, stop } = chat;
  useEffect(() => onTaskRunning?.(running), [running, onTaskRunning]);
  useEffect(() => subscribeStop?.(stop), [subscribeStop, stop]);

  const disabled = channel === null;
  const connecting = chat.conversation.connection !== 'open';
  const blocked = disabled
    ? withoutChannel(daemon)
    : connecting
      ? strings.chat.disabled.connecting
      : null;

  // DK-13: every message goes as it is; the daemon decides whether it is a look or a task.
  const submit = () => {
    const typed = draft.text.trim();
    if (typed === '' && draft.attachments.length === 0) return;
    // S5: Enter with no way to send is not dropped in silence: the reason is announced, and
    // the message waits in the composer; nothing is queued.
    if (blocked !== null) {
      draft.warn(strings.chat.heldBack(blocked));
      return;
    }
    chat.say(typed, draft.attachments);
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
        waiting={waiting}
        empty={emptyStateFor(disabled ? daemon : null, props.onStart)}
        onRetry={chat.retry}
        onRestart={chat.restart}
        onPress={chat.press}
        onAllow={chat.allow}
        onRefuse={chat.refuse}
        onAddWebSearch={onAddWebSearch === undefined ? undefined : chat.addWebSearch}
      />
      {chat.running && (
        <div className="task-bar">
          <span>{strings.chat.computerRunning}</span>
          <button type="button" className="button small" onClick={chat.stop}>
            {strings.chat.computerStop}
          </button>
        </div>
      )}
      <Composer
        text={draft.text}
        attachments={draft.attachments}
        notice={draft.notice}
        disabled={disabled}
        blocked={blocked}
        onText={draft.setText}
        onFiles={draft.addFiles}
        model={model}
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
