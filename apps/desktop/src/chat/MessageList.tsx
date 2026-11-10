// DK-4: the conversation. Presentational: messages in, a retry or a press out.
import { useLayoutEffect, useRef } from 'react';
import { strings } from '../strings.ts';
import { AlertIcon, FileIcon, Mark } from '../ui/icons.tsx';
import type { Attachment } from './attachments.ts';
import type { BotMessage, Message, OwnMessage } from './conversation.ts';

export interface MessageListProps {
  messages: Message[];
  /** The daemon owes an answer. */
  waiting: boolean;
  onRetry: (message: OwnMessage) => void;
  onPress: (message: BotMessage, data: string) => void;
  /** DK-10 AC1: the principal allows the action a message proposes, or stops there. */
  onAllow: (message: BotMessage) => void;
  onRefuse: (message: BotMessage) => void;
}

/** How far from the end still counts as reading the latest message. */
const NEAR_END_PX = 80;

const Thumbnail = ({ attachment }: { attachment: Attachment }) =>
  attachment.previewUrl === null ? (
    <li className="file-chip">
      <FileIcon />
      <span className="file-name">{attachment.name}</span>
    </li>
  ) : (
    <li className="thumbnail">
      <img src={attachment.previewUrl} alt={attachment.name} />
    </li>
  );

const Problem = ({ children }: { children: string }) => (
  <p className="message-problem">
    <AlertIcon />
    <span>{children}</span>
  </p>
);

const Own = ({
  message,
  onRetry,
}: {
  message: OwnMessage;
  onRetry: MessageListProps['onRetry'];
}) => (
  <li className="message own" data-delivery={message.delivery}>
    <span className="sr-only">{strings.chat.you}</span>
    <div className="bubble">
      {message.attachments.length > 0 && (
        <ul className="thumbnails" data-count={message.attachments.length}>
          {message.attachments.map((attachment) => (
            <Thumbnail key={attachment.id} attachment={attachment} />
          ))}
        </ul>
      )}
      {message.text !== '' && <p className="message-text">{message.text}</p>}
    </div>
    {message.delivery === 'not_sent' && (
      <div className="message-status">
        <Problem>{strings.chat.notSent}</Problem>
        <button type="button" className="button small" onClick={() => onRetry(message)}>
          {strings.chat.sendAgain}
        </button>
      </div>
    )}
    {/* DK-4, delivery honesty: the daemon may have registered it, so no one-click resend here. */}
    {message.delivery === 'unknown' && (
      <div className="message-status">
        <Problem>{strings.chat.unknown}</Problem>
      </div>
    )}
  </li>
);

/**
 * DK-10 AC1, AC3: an action waiting for the principal. For a click or a scroll, the capture
 * itself around the point, with a mark on it: what is really there, whatever the text claims.
 * Once answered, in either way, it is never offered again.
 */
const ProposalCard = ({
  message,
  proposal,
  onAllow,
  onRefuse,
}: {
  message: BotMessage;
  proposal: NonNullable<BotMessage['proposal']>;
  onAllow: MessageListProps['onAllow'];
  onRefuse: MessageListProps['onRefuse'];
}) => {
  const { press } = message;
  const { action } = proposal;
  const point =
    action.kind === 'click' || action.kind === 'scroll'
      ? { left: `${action.x / 10}%`, top: `${action.y / 10}%` }
      : null;
  return (
    <>
      {point !== null && (
        <div
          className="target-preview"
          role="img"
          aria-label={strings.chat.computerPreview}
          style={{
            backgroundImage: `url("${proposal.captureUrl}")`,
            backgroundPosition: `${point.left} ${point.top}`,
          }}
        >
          <span className="target-mark" style={point} />
        </div>
      )}
      <div className="choices">
        <button
          type="button"
          className="button choice"
          data-chosen={press?.data === 'allow' ? press.delivery : undefined}
          disabled={press !== null}
          onClick={() => onAllow(message)}
        >
          {strings.chat.computerAllow}
        </button>
        <button
          type="button"
          className="button choice"
          data-chosen={press?.data === 'refuse' ? press.delivery : undefined}
          disabled={press !== null}
          onClick={() => onRefuse(message)}
        >
          {strings.chat.computerRefuse}
        </button>
      </div>
      {press?.data === 'refuse' && <p className="message-note">{strings.chat.computerRefused}</p>}
      {press?.data === 'allow' && press.delivery === 'unknown' && (
        <Problem>{strings.chat.computerUnknown}</Problem>
      )}
    </>
  );
};

const Bot = ({
  message,
  onPress,
  onAllow,
  onRefuse,
}: {
  message: BotMessage;
  onPress: MessageListProps['onPress'];
  onAllow: MessageListProps['onAllow'];
  onRefuse: MessageListProps['onRefuse'];
}) => {
  const { press, proposal } = message;
  const choices = message.buttons.filter((button) => 'data' in button);
  // DK-4 AC7: this WebView cannot open a link, so a link button is named, never offered.
  const links = message.buttons.filter((button) => 'url' in button);
  return (
    <li className="message bot">
      <span className="sr-only">{strings.chat.bot}</span>
      {/* DK-4 AC1: exactly as received. A text node: never HTML, never Markdown. */}
      <p className="message-text">{message.text}</p>
      {choices.length > 0 && (
        <div className="choices">
          {choices.map((button) => (
            <button
              key={button.data}
              type="button"
              className="button choice"
              data-chosen={press?.data === button.data ? press.delivery : undefined}
              disabled={press?.delivery === 'pending'}
              onClick={() => onPress(message, button.data)}
            >
              {button.label}
            </button>
          ))}
        </div>
      )}
      {proposal !== null && (
        <ProposalCard message={message} proposal={proposal} onAllow={onAllow} onRefuse={onRefuse} />
      )}
      {proposal === null && press?.delivery === 'not_sent' && (
        <Problem>{strings.chat.pressNotSent}</Problem>
      )}
      {proposal === null && press?.delivery === 'unknown' && (
        <Problem>{strings.chat.pressUnknown}</Problem>
      )}
      {links.map((button) => (
        <p key={button.label} className="message-note">
          {strings.chat.linkOnlyInTelegram(button.label)}
        </p>
      ))}
    </li>
  );
};

export function MessageList(props: MessageListProps) {
  const { messages, waiting, onRetry, onPress, onAllow, onRefuse } = props;
  const scroller = useRef<HTMLDivElement>(null);
  /** Whether the principal is reading the end; scrolling up to reread must not be undone. */
  const atEnd = useRef(true);
  const last = messages.at(-1);

  // Follows the conversation: always after the principal's own message, otherwise only when
  // they were already at the end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the conversation grows.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    if (atEnd.current || last?.kind === 'own') element.scrollTop = element.scrollHeight;
  }, [messages.length, waiting, last?.kind]);

  return (
    <div
      className="conversation"
      ref={scroller}
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        atEnd.current = scrollHeight - scrollTop - clientHeight < NEAR_END_PX;
      }}
    >
      {messages.length === 0 && (
        <div className="empty">
          <Mark size={40} />
          <h2 className="empty-title">{strings.chat.emptyTitle}</h2>
          <p className="empty-body">{strings.chat.emptyBody}</p>
        </div>
      )}
      <ol className="messages" role="log" aria-live="polite" aria-label={strings.chat.conversation}>
        {messages.map((message) =>
          message.kind === 'own' ? (
            <Own key={message.id} message={message} onRetry={onRetry} />
          ) : (
            <Bot
              key={message.id}
              message={message}
              onPress={onPress}
              onAllow={onAllow}
              onRefuse={onRefuse}
            />
          ),
        )}
      </ol>
      {waiting && (
        <div className="thinking">
          <span className="sr-only">{strings.chat.thinking}</span>
          <span className="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      )}
    </div>
  );
}
