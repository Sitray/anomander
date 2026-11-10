// DK-4: the chat. The container: it owns the connection and the draft, and hands both to the
// presentational list and composer.
import type { ComputerAction } from '@anomander/protocol';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
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
  /** Called whenever the chat starts or stops waiting for an answer, and with `false` on leaving. */
  onThinking?: (thinking: boolean) => void;
  /** Called with the text of every answer. */
  onReply?: (text: string) => void;
  /** Takes a JPEG of the screen; rejects with `screen_permission` when macOS does not allow it. */
  onCaptureScreen?: () => Promise<ArrayBuffer>;
  /**
   * DK-10: performs one action on the computer and answers with a JPEG of the screen after it.
   * Rejects with `computer_permission` or `screen_permission` when macOS does not allow it.
   */
  onPerformAction?: (action: ComputerAction) => Promise<ArrayBuffer>;
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
  const draft = useDraft();
  const computer = useMemo(
    () =>
      onCaptureScreen === undefined || onPerformAction === undefined
        ? undefined
        : { capture: onCaptureScreen, perform: onPerformAction },
    [onCaptureScreen, onPerformAction],
  );
  const chat = useChat(channel, {
    ...(onReply === undefined ? {} : { onReply }),
    ...(computer === undefined ? {} : { computer }),
    onProblem: draft.warn,
  });
  /** The next message is a task on the computer. */
  const [control, setControl] = useState(false);
  const [dropping, setDropping] = useState(false);
  /** `dragenter` minus `dragleave`: both also fire for every child the pointer crosses. */
  const dragDepth = useRef(0);

  const waiting = isWaiting(chat.conversation);
  useEffect(() => onThinking?.(waiting), [waiting, onThinking]);
  useEffect(() => () => onThinking?.(false), [onThinking]);

  const disabled = channel === null;
  const connecting = chat.conversation.connection !== 'open';
  const blocked = disabled
    ? withoutChannel(daemon)
    : connecting
      ? strings.chat.disabled.connecting
      : null;

  const submit = () => {
    const typed = draft.text.trim();
    if (blocked !== null || (typed === '' && draft.attachments.length === 0)) return;
    if (control) {
      if (draft.attachments.length > 0) {
        draft.warn(strings.chat.computerAlone);
        return;
      }
      chat.task(typed);
      draft.clear();
      // One task at a time: the next message is a plain one again.
      setControl(false);
      return;
    }
    // A capture always goes with a question: without words, the obvious one.
    const capture = draft.attachments.some((attachment) => attachment.screen);
    chat.say(capture && typed === '' ? strings.chat.screenQuestion : typed, draft.attachments);
    draft.clear();
  };

  const look =
    onCaptureScreen === undefined
      ? undefined
      : () => {
          if (!draft.takesScreen()) return;
          onCaptureScreen().then(draft.addScreen, (error: unknown) =>
            draft.warn(
              error === 'screen_permission'
                ? strings.chat.screenPermission
                : strings.chat.screenFailed,
            ),
          );
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
        onRetry={chat.retry}
        onPress={chat.press}
        onAllow={chat.allow}
        onRefuse={chat.refuse}
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
        {...(look === undefined ? {} : { onScreen: look })}
        {...(computer === undefined
          ? {}
          : { control: { on: control, onToggle: () => setControl((on) => !on) } })}
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
