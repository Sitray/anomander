import { type DragEvent, useState } from 'react';
import { strings } from '../strings.ts';
import { Composer, type ComposerProps } from './Composer.tsx';
import { MessageList, type MessageListProps } from './MessageList.tsx';

export type ChatScreenProps = MessageListProps & ComposerProps;

const carriesFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

/** DK-4: the conversation and the composer; files dropped anywhere on it join the draft. */
export const ChatScreen = (props: ChatScreenProps) => {
  const [dragging, setDragging] = useState(false);
  const accepting = props.disabledReason === null;

  return (
    <main
      className="chat"
      data-dragging={(dragging && accepting) || undefined}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = accepting ? 'copy' : 'none';
        setDragging(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (accepting) props.onAddFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <MessageList
        messages={props.messages}
        canSend={props.canSend}
        onPress={props.onPress}
        onRetry={props.onRetry}
        onOpenUrl={props.onOpenUrl}
      />
      <Composer
        text={props.text}
        attachments={props.attachments}
        notice={props.notice}
        tooLong={props.tooLong}
        disabledReason={props.disabledReason}
        waitingReason={props.waitingReason}
        onTextChange={props.onTextChange}
        onAddFiles={props.onAddFiles}
        onRemoveAttachment={props.onRemoveAttachment}
        onSubmit={props.onSubmit}
      />
      <div className="drop-overlay" aria-hidden="true">
        <p>{strings.dropHere}</p>
      </div>
    </main>
  );
};
