// DK-4: the conversation. Presentational: messages in, a retry or a press out.
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DaemonStatus } from '../shell.ts';
import { strings } from '../strings.ts';
import { AlertIcon, CheckIcon, CopyIcon, FileIcon, Mark } from '../ui/icons.tsx';
import type { Attachment } from './attachments.ts';
import type { BotMessage, Message, OwnMessage } from './conversation.ts';
import { isWebAddress, piecesOf } from './links.ts';
import { matchesIn } from './search.ts';
import type { Turn } from './use-chat.ts';

/** What the empty conversation says, and what it offers. */
export interface EmptyState {
  title: string;
  body: string;
  action?: { label: string; run: () => void };
  /** B23: what can be asked here, offered while there is a channel. */
  examples?: readonly string[];
}

/**
 * S5: the empty chat keyed to the daemon, so it never asks for an expense the composer cannot
 * send. `daemon` is `null` while there is a channel: then the chat says what can be done here.
 */
export const emptyStateFor = (daemon: DaemonStatus | null, onStart?: () => void): EmptyState => {
  const { chat } = strings;
  if (daemon === null) {
    return { title: chat.emptyTitle, body: chat.emptyBody, examples: chat.examples };
  }
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
  /** DK-19: the answer owed, to say its phase and offer to stop it; absent, only that it works. */
  turn?: Turn | null;
  /** DK-19: stops the turn owed, when it can be stopped. */
  onStop?: () => void;
  /** B23: puts an example in the composer; it is never sent by itself. */
  onExample?: (text: string) => void;
  /**
   * B25: opens a web address in the principal's browser. Absent where the window cannot: the
   * addresses stay plain text and a link button is only named.
   */
  onOpenLink?: ((url: string) => void) | undefined;
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
  /** DK-21: what the principal searches for; its matches are highlighted. */
  search?: string;
}

/** How long a copied message shows it was. */
const COPIED_MS = 2000;

/**
 * DK-21: `text` from `from` to `to`, with the part of every match in it marked. Text nodes only:
 * never HTML. A match that crosses the ends is marked up to them, so a reply cut into pieces
 * (B25) keeps the marks of its whole text.
 */
const marked = (
  text: string,
  matches: ReadonlyArray<[number, number]>,
  from = 0,
  to = text.length,
): ReactNode[] => {
  const parts: ReactNode[] = [];
  let at = from;
  for (const [start, end] of matches) {
    const markFrom = Math.max(start, from);
    const markTo = Math.min(end, to);
    if (markFrom >= markTo) continue;
    parts.push(
      text.slice(at, markFrom),
      <mark key={markFrom}>{text.slice(markFrom, markTo)}</mark>,
    );
    at = markTo;
  }
  parts.push(text.slice(at, to));
  return parts;
};

/** DK-21: `text` with every match of `search` marked. Text nodes only: never HTML. */
const Highlighted = ({ text, search }: { text: string; search: string }) => (
  <>{marked(text, matchesIn(text, search))}</>
);

/** DK-21: when a message was sent and its copy button, under it. */
const Meta = ({
  message,
  copied,
  onCopy,
}: {
  message: Message;
  copied: boolean;
  onCopy: (message: Message) => void;
}) => {
  if (message.at === undefined && message.text === '') return null;
  return (
    <div className="message-meta">
      {message.at !== undefined && (
        <time dateTime={message.at}>{strings.chat.messageTime(message.at, new Date())}</time>
      )}
      {message.text !== '' && (
        <button
          type="button"
          className="message-copy"
          aria-label={strings.chat.copy}
          title={strings.chat.copy}
          data-copied={copied || undefined}
          onClick={() => onCopy(message)}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      )}
    </div>
  );
};

/** What `Own` and `Bot` share for DK-21. */
interface Reading {
  search: string;
  copied: boolean;
  onCopy: (message: Message) => void;
}

/** DK-19: what ANOMANDER is doing for the answer owed, in words. */
const phaseOf = (turn: Turn | null): string => {
  const { chat } = strings;
  if (turn === null) return chat.thinking;
  if (turn.stopping) return chat.stopping;
  if (turn.phase === 'web_search') return chat.searchingWeb;
  if (turn.phase === 'connection') return chat.usingConnections;
  if (turn.kind === 'screen') return chat.lookingAtScreen;
  if (turn.kind === 'receipt') return chat.readingReceipt;
  return chat.thinking;
};

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
  search,
  copied,
  onCopy,
}: {
  message: OwnMessage;
  onRetry: MessageListProps['onRetry'];
} & Reading) => (
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
      {message.text !== '' && (
        <p className="message-text">
          <Highlighted text={message.text} search={search} />
        </p>
      )}
    </div>
    <Meta message={message} copied={copied} onCopy={onCopy} />
    {message.door === 'telegram' && <p className="message-note">{strings.chat.viaTelegram}</p>}
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

/**
 * B25: a reply's text, exactly as received (DK-4 AC1): text nodes, never HTML or Markdown. Where
 * the window can open them, its http(s) addresses are links to the browser; never in the window.
 */
const ReplyText = ({
  text,
  search,
  onOpenLink,
}: {
  text: string;
  /** DK-21: its matches are marked, in the links too. */
  search: string;
  onOpenLink: MessageListProps['onOpenLink'];
}) => {
  if (onOpenLink === undefined) {
    return (
      <p className="message-text">
        <Highlighted text={text} search={search} />
      </p>
    );
  }
  const matches = matchesIn(text, search);
  let from = 0;
  return (
    <p className="message-text">
      {piecesOf(text).map((piece, index) => {
        const start = from;
        const end = start + ('url' in piece ? piece.url : piece.text).length;
        from = end;
        return 'url' in piece ? (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one text never move.
            key={index}
            className="message-link"
            href={piece.url}
            rel="noreferrer"
            onClick={(event) => {
              event.preventDefault();
              onOpenLink(piece.url);
            }}
          >
            {marked(text, matches, start, end)}
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one text never move.
          <Fragment key={index}>{marked(text, matches, start, end)}</Fragment>
        );
      })}
    </p>
  );
};

const Bot = ({
  message,
  onRestart,
  onPress,
  onAllow,
  onRefuse,
  onAddWebSearch,
  onOpenLink,
  search,
  copied,
  onCopy,
}: {
  message: BotMessage;
  onRestart: MessageListProps['onRestart'];
  onPress: MessageListProps['onPress'];
  onAllow: MessageListProps['onAllow'];
  onRefuse: MessageListProps['onRefuse'];
  onAddWebSearch: MessageListProps['onAddWebSearch'];
  onOpenLink: MessageListProps['onOpenLink'];
} & Reading) => {
  const { press, proposal, start, offer } = message;
  const choices = message.buttons.filter((button) => 'data' in button);
  // DK-4 AC7, B25: a link button opens its address where the window can; otherwise it is named.
  const links = message.buttons.filter((button) => 'url' in button);
  const opens = (url: string) => onOpenLink !== undefined && isWebAddress(url);
  return (
    <li className="message bot">
      <span className="sr-only">{strings.chat.bot}</span>
      <ReplyText text={message.text} search={search} onOpenLink={onOpenLink} />
      <Meta message={message} copied={copied} onCopy={onCopy} />
      {message.door === 'telegram' && <p className="message-note">{strings.chat.viaTelegram}</p>}
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
      {links.some((button) => opens(button.url)) && (
        <div className="choices">
          {links
            .filter((button) => opens(button.url))
            .map((button) => (
              <button
                key={button.label}
                type="button"
                className="button choice"
                onClick={() => onOpenLink?.(button.url)}
              >
                {button.label}
              </button>
            ))}
        </div>
      )}
      {links
        .filter((button) => !opens(button.url))
        .map((button) => (
          <p key={button.label} className="message-note">
            {strings.chat.linkOnlyInTelegram(button.label)}
          </p>
        ))}
    </li>
  );
};

export function MessageList(props: MessageListProps) {
  const { messages, waiting, onRetry, onRestart, onPress, onAllow, onRefuse } = props;
  const { onAddWebSearch, turn = null, onStop, onExample, onOpenLink, search = '' } = props;
  const empty = props.empty ?? emptyStateFor(null);
  /** DK-21: the message just copied, for a moment. */
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (message: Message) => {
    navigator.clipboard.writeText(message.text).then(
      () => setCopied(message.id),
      // Nothing was copied: the button stays as it was.
      () => {},
    );
  };
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

  // DK-21: the first match of a search comes into view.
  useEffect(() => {
    if (search.trim() === '') return;
    scroller.current?.querySelector('mark')?.scrollIntoView?.({ block: 'center' });
  }, [search]);

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
          {empty.examples !== undefined && onExample !== undefined && (
            <ul className="examples" aria-label={strings.chat.examplesLabel}>
              {empty.examples.map((example) => (
                <li key={example}>
                  <button type="button" className="example" onClick={() => onExample(example)}>
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ol className="messages" role="log" aria-live="polite" aria-label={strings.chat.conversation}>
        {messages.map((message) =>
          message.kind === 'own' ? (
            <Own
              key={message.id}
              message={message}
              onRetry={onRetry}
              search={search}
              copied={copied === message.id}
              onCopy={copy}
            />
          ) : (
            <Bot
              key={message.id}
              message={message}
              onRestart={onRestart}
              onPress={onPress}
              onAllow={onAllow}
              onRefuse={onRefuse}
              onAddWebSearch={onAddWebSearch}
              onOpenLink={onOpenLink}
              search={search}
              copied={copied === message.id}
              onCopy={copy}
            />
          ),
        )}
      </ol>
      {/* DK-21: said once, wherever the message was copied from. */}
      <p className="sr-only" aria-live="polite">
        {copied === null ? '' : strings.chat.copied}
      </p>
      {/* DK-19: the phase is in a live region that is always there, so each change is announced. */}
      <div className="thinking" data-waiting={waiting || undefined}>
        <p className="thinking-status" aria-live="polite">
          {waiting && (
            <>
              <span className="thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="thinking-phase">{phaseOf(turn)}</span>
            </>
          )}
        </p>
        {waiting && turn?.stoppable === true && onStop !== undefined && (
          <button
            type="button"
            className="link"
            title={strings.chat.stopTurnHint}
            aria-keyshortcuts="Escape"
            disabled={turn.stopping}
            onClick={onStop}
          >
            {strings.chat.stopTurn}
          </button>
        )}
      </div>
    </div>
  );
}
