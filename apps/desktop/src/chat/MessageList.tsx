import type { ChatButton } from '@anomander/protocol';
import { useEffect, useRef } from 'react';
import { strings } from '../strings.ts';
import { CheckIcon, ExternalIcon, RetryIcon } from '../ui/icons.tsx';
import { isImage, previewUrl } from './attachments.ts';
import type { AnomanderMessage, ChatMessage, PrincipalMessage } from './chat-state.ts';

export interface MessageListProps {
  messages: ChatMessage[];
  /** Whether a request can leave now; retries and presses wait for it. */
  canSend: boolean;
  onPress: (reply: AnomanderMessage, index: number) => void;
  onRetry: (message: PrincipalMessage) => void;
  onOpenUrl: (url: string) => void;
}

/** DK-4 AC3: a URL button opens only an `https:` address. */
export const isOpenableUrl = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

const Principal = ({
  message,
  canSend,
  onRetry,
}: {
  message: PrincipalMessage;
  canSend: boolean;
  onRetry: MessageListProps['onRetry'];
}) => (
  <li className="message message--principal" data-status={message.status}>
    <span className="visually-hidden">{strings.you}: </span>
    <div className="bubble">
      {message.attachments.length > 0 && (
        <div className="bubble-files" data-count={Math.min(message.attachments.length, 3)}>
          {message.attachments.map((attachment, index) =>
            isImage(attachment) ? (
              <img
                // Attachments never change once sent: their position is their identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                key={index}
                src={previewUrl(attachment)}
                alt={strings.receiptImage(index + 1)}
              />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <span key={index} className="file-chip">
                {attachment.name}
              </span>
            ),
          )}
        </div>
      )}
      {message.text !== null && <p className="bubble-text">{message.text}</p>}
    </div>
    {message.status === 'sending' && <p className="message-meta">{strings.sending}</p>}
    {message.status === 'failed' && (
      <p className="message-meta message-meta--error">
        {strings.notSent}
        <button
          type="button"
          className="link-button"
          disabled={!canSend}
          onClick={() => onRetry(message)}
        >
          <RetryIcon />
          {strings.retry}
        </button>
      </p>
    )}
  </li>
);

const ReplyButton = ({
  button,
  chosen,
  disabled,
  onPress,
  onOpenUrl,
}: {
  button: ChatButton;
  chosen: boolean;
  disabled: boolean;
  onPress: () => void;
  onOpenUrl: MessageListProps['onOpenUrl'];
}) => {
  if ('url' in button) {
    const openable = isOpenableUrl(button.url);
    return (
      <button
        type="button"
        className="reply-button"
        disabled={!openable}
        title={openable ? button.url : undefined}
        onClick={() => {
          if (openable) onOpenUrl(button.url);
        }}
      >
        {button.label}
        <ExternalIcon />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="reply-button"
      data-chosen={chosen || undefined}
      disabled={disabled}
      onClick={onPress}
    >
      {chosen && <CheckIcon />}
      {button.label}
      {chosen && <span className="visually-hidden"> {strings.chosen}</span>}
    </button>
  );
};

const Anomander = ({
  message,
  canSend,
  onPress,
  onOpenUrl,
}: {
  message: AnomanderMessage;
  canSend: boolean;
  onPress: MessageListProps['onPress'];
  onOpenUrl: MessageListProps['onOpenUrl'];
}) => {
  const { press } = message;
  const settled = press.state === 'waiting' || press.state === 'answered';
  return (
    <li className="message message--anomander">
      <span className="visually-hidden">{strings.appName}: </span>
      <div className="bubble">
        {/* The daemon's text, verbatim: React renders it as text, never as markup. */}
        <p className="bubble-text">{message.text}</p>
      </div>
      {message.buttons.length > 0 && (
        <div className="reply-buttons" aria-busy={press.state === 'waiting'}>
          {message.buttons.map((button, index) => (
            <ReplyButton
              // A reply's buttons never change: their position is their identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              button={button}
              chosen={settled && press.index === index}
              disabled={settled || !canSend}
              onPress={() => onPress(message, index)}
              onOpenUrl={onOpenUrl}
            />
          ))}
        </div>
      )}
      {press.state === 'waiting' && <p className="message-meta">{strings.sending}</p>}
      {press.state === 'failed' && (
        <p className="message-meta message-meta--error">{strings.pressNotSent}</p>
      )}
    </li>
  );
};

export const MessageList = ({
  messages,
  canSend,
  onPress,
  onRetry,
  onOpenUrl,
}: MessageListProps) => {
  const scroller = useRef<HTMLDivElement>(null);
  const count = messages.length;

  // Follow the conversation: each new message scrolls into view.
  useEffect(() => {
    const element = scroller.current;
    if (element !== null && count > 0) element.scrollTop = element.scrollHeight;
  }, [count]);

  return (
    <div className="log" ref={scroller}>
      {count === 0 && (
        <div className="empty">
          <h2 className="empty-title">{strings.emptyTitle}</h2>
          <p className="empty-hint">{strings.emptyHint}</p>
        </div>
      )}
      {/* biome-ignore lint/a11y/noRedundantRoles: WebKit drops list semantics without it */}
      <ol className="messages" role="list" aria-label={strings.conversation}>
        {messages.map((message) =>
          message.kind === 'principal' ? (
            <Principal key={message.key} message={message} canSend={canSend} onRetry={onRetry} />
          ) : (
            <Anomander
              key={message.key}
              message={message}
              canSend={canSend}
              onPress={onPress}
              onOpenUrl={onOpenUrl}
            />
          ),
        )}
      </ol>
    </div>
  );
};
