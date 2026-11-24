// DK-4: the conversation. Presentational: messages in, a retry or a press out.
import { useLayoutEffect, useRef } from 'react';
import type { DaemonStatus } from '../shell.ts';
import { strings } from '../strings.ts';
import { AlertIcon, FileIcon, Mark } from '../ui/icons.tsx';
import type { Attachment } from './attachments.ts';
import type { BotMessage, Message, OwnMessage } from './conversation.ts';

/** What the empty conversation says, and what it offers. */
export interface EmptyState {
  title: string;
  body: string;
  action?: { label: string; run: () => void };
}

/**
 * S5: the empty chat keyed to the daemon, so it never asks for an expense the composer cannot
 * send. `daemon` is `null` while there is a channel: then the chat says what can be done here.
 */
export const emptyStateFor = (daemon: DaemonStatus | null, onStart?: () => void): EmptyState => {
  const { chat } = strings;
  if (daemon === null) return { title: chat.emptyTitle, body: chat.emptyBody };
  if (daemon.state === 'failing') return chat.emptyFailing;
  if (daemon.state === 'stopped') {
    if (daemon.reason === 'not_configured') return chat.emptyNotConfigured;
    const { title, body, action } = chat.emptyStopped;
    return onStart === undefined
      ? { title, body }
      : { title, body, action: { label: action, run: onStart } };
  }
  return chat.emptyStarting;
};

export interface MessageListProps {
  messages: Message[];
  /** The daemon owes an answer. */
  waiting: boolean;
  /** What the empty conversation says; by default, what can be done here. */
  empty?: EmptyState;
  onRetry: (message: OwnMessage) => void;
  /** DK-13: starts again the look or the task a message announced, which did not leave. */
  onRestart: (message: BotMessage) => void;
  onPress: (message: BotMessage, data: string) => void;
  /** DK-10 AC1: the principal allows the action a message proposes, or stops there. */
  onAllow: (message: BotMessage) => void;
  onRefuse: (message: BotMessage) => void;
  /** DK-11 AC13: adds the web search a message offers. Absent where the window cannot. */
  onAddWebSearch?: ((message: BotMessage) => void) | undefined;
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
      {proposal.seen !== null && <p className="message-note">{proposal.seen}</p>}
      {!proposal.confirm && <p className="message-note">{strings.chat.computerAuto}</p>}
      {proposal.confirm && (
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
      )}
      {press?.data === 'refuse' && <p className="message-note">{strings.chat.computerRefused}</p>}
      {press?.data === 'allow' && press.delivery === 'unknown' && (
        <Problem>{strings.chat.computerUnknown}</Problem>
      )}
    </>
  );
};

/**
 * DK-13: what a reply that announced a look or a task started. A look shows the capture it sent;
 * one that did not leave can start again, as what it is.
 */
const StartStatus = ({
  message,
  start,
  onRestart,
}: {
  message: BotMessage;
  start: NonNullable<BotMessage['start']>;
  onRestart: MessageListProps['onRestart'];
}) => (
  <>
    {start.captureUrl !== null && (
      <ul className="thumbnails" data-count={1}>
        <li className="thumbnail">
          <img src={start.captureUrl} alt={strings.chat.screenCapture} />
        </li>
      </ul>
    )}
    {start.delivery === 'not_sent' && (
      <div className="message-status">
        <Problem>
          {start.route.to === 'screen' ? strings.chat.lookNotSent : strings.chat.taskNotSent}
        </Problem>
        <button type="button" className="button small" onClick={() => onRestart(message)}>
          {strings.chat.startAgain}
        </button>
      </div>
    )}
    {start.delivery === 'unknown' && <Problem>{strings.chat.startUnknown}</Problem>}
  </>
);

/**
 * DK-11 AC13: the web search the reply says is missing, offered in one press with what leaves the
 * Mac; once added, the request is asked again.
 */
const OfferCard = ({
  message,
  offer,
  onAdd,
}: {
  message: BotMessage;
  offer: NonNullable<BotMessage['offer']>;
  onAdd: (message: BotMessage) => void;
}) => {
  if (offer.state === 'added' || offer.state === 'already') {
    const note =
      offer.state === 'added' ? strings.chat.webSearchAdded : strings.chat.webSearchAlreadyOn;
    return <p className="message-note">{note}</p>;
  }
  const adding = offer.state === 'adding';
  return (
    <div className="offer">
      <p className="message-note">{strings.connections.webSearchNote}</p>
      {offer.state === 'failed' && (
        <Problem>
          {offer.why === 'not_back' ? strings.chat.webSearchNotBack : strings.chat.webSearchFailed}
        </Problem>
      )}
      <button
        type="button"
        className="button small"
        disabled={adding}
        aria-label={strings.chat.addWebSearch}
        onClick={() => onAdd(message)}
      >
        {adding ? strings.chat.addingWebSearch : strings.chat.addWebSearch}
      </button>
    </div>
  );
};

const Bot = ({
  message,
  onRestart,
  onPress,
  onAllow,
  onRefuse,
  onAddWebSearch,
}: {
  message: BotMessage;
  onRestart: MessageListProps['onRestart'];
  onPress: MessageListProps['onPress'];
  onAllow: MessageListProps['onAllow'];
  onRefuse: MessageListProps['onRefuse'];
  onAddWebSearch: MessageListProps['onAddWebSearch'];
}) => {
  const { press, proposal, start, offer } = message;
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
      {start !== null && <StartStatus message={message} start={start} onRestart={onRestart} />}
      {offer !== null && onAddWebSearch !== undefined && (
        <OfferCard message={message} offer={offer} onAdd={onAddWebSearch} />
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
  const { messages, waiting, onRetry, onRestart, onPress, onAllow, onRefuse } = props;
  const { onAddWebSearch } = props;
  const empty = props.empty ?? emptyStateFor(null);
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
          <h2 className="empty-title">{empty.title}</h2>
          <p className="empty-body">{empty.body}</p>
          {empty.action !== undefined && (
            <button type="button" className="button primary" onClick={empty.action.run}>
              {empty.action.label}
            </button>
          )}
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
              onRestart={onRestart}
              onPress={onPress}
              onAllow={onAllow}
              onRefuse={onRefuse}
              onAddWebSearch={onAddWebSearch}
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
