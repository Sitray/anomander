// DK-4: the conversation as the window shows it. A pure reducer, in memory only (never
// localStorage or disk): the daemon keeps what was said, and the window shows it again (DK-16).
import type { ChatButton, ChatReply, ChatStoredMessage, ComputerAction } from '@anomander/protocol';
import type { Attachment } from './attachments.ts';
import type { ConnectionState, Outcome } from './chat-client.ts';

/**
 * What the principal is told about something they sent:
 * - `pending`: no answer yet;
 * - `delivered`: the daemon handled it;
 * - `not_sent`: nothing was done with it, so it can be sent again;
 * - `unknown`: the connection was lost in flight; the daemon may have handled it.
 */
export type Delivery = 'pending' | 'delivered' | 'not_sent' | 'unknown';

export interface OwnMessage {
  kind: 'own';
  id: string;
  text: string;
  attachments: Attachment[];
  delivery: Delivery;
  /** `null` until it left through the socket. */
  requestId: string | null;
  /** DK-16: a stored message that came through Telegram. */
  door?: 'telegram';
}

/** DK-13: the look at the screen or the task on the computer a plain text was routed to. */
export type Route = NonNullable<ChatReply['route']>;

/**
 * What a reply that announces a route started: a `screen` request with a capture, or the first
 * step of a task. It is sent again as what it is, never as a plain text.
 */
export interface Start {
  route: Route;
  delivery: Delivery;
  /** `null` until it left through the socket. */
  requestId: string | null;
  /** The capture a look sent, as an object URL; `null` for a task or before it was taken. */
  captureUrl: string | null;
}

/**
 * An action ANOMANDER proposes on the computer (DK-10), waiting for the principal. Its `press`
 * is their answer: `allow`, pending until the next step is answered, or `refuse`.
 */
export interface Proposal {
  action: ComputerAction;
  /** The capture the action was planned on, as an object URL, to show where it would land. */
  captureUrl: string;
  /** Whether the principal must allow it; `false` for a routine step, performed without asking. */
  confirm: boolean;
  /** T1b: what the shell read on the screen where the step would act, when it asked for it. */
  seen: string | null;
}

/** The last press on one of a reply's buttons (DK-4 AC3). */
export interface Press {
  data: string;
  delivery: Delivery;
  requestId: string | null;
}

export interface BotMessage {
  kind: 'bot';
  id: string;
  channelRef: string;
  text: string;
  buttons: ChatButton[];
  press: Press | null;
  /** `null` for every reply that proposes nothing. */
  proposal: Proposal | null;
  /** `null` for every reply that announces no route the window starts. */
  start: Start | null;
  /** DK-11 AC13: the web search the reply says is missing; `null` when it says nothing so. */
  offer: Offer | null;
  /** DK-16: a stored message that came through Telegram. */
  door?: 'telegram';
}

/** DK-11 AC13: the web search offered in one press, and the request asked again once added. */
export interface Offer {
  /** The text the reply answered, asked again once the web search is there. */
  ask: string;
  /** `already`: a server had its name before the press, so nothing was saved. */
  state: 'offered' | 'adding' | 'failed' | 'added' | 'already';
  /**
   * Why it `failed`: `not_back` when it was added but the daemon that reads it did not come back
   * in time, so the request was not asked again; `null` when it could not be added.
   */
  why: 'not_back' | null;
}

export type Message = OwnMessage | BotMessage;

export interface Conversation {
  connection: ConnectionState;
  messages: Message[];
}

export type ConversationAction =
  | { type: 'connection'; state: ConnectionState }
  /** The principal sent a message; it has not left yet. */
  | { type: 'said'; id: string; text: string; attachments: Attachment[] }
  /** The principal asked to send a message that was not sent again. */
  | { type: 'retried'; id: string }
  /** A message left through the socket as `requestId`, or could not leave at all (`null`). */
  | { type: 'left'; id: string; requestId: string | null }
  /** A press on a button of the reply `id` left as `requestId`, or could not leave (`null`). */
  | { type: 'pressed'; id: string; data: string; requestId: string | null }
  /**
   * `proposal` is set only for the answer to a step of a task the principal asked for: an action
   * in any other reply is never offered. `start` only for the answer to a plain text whose route
   * the window starts now (DK-13).
   */
  | { type: 'outcome'; requestId: string; outcome: Outcome; proposal?: Proposal; start?: Route }
  /** What the reply `id` started left as `requestId`, or could not leave (`null`), this time. */
  | { type: 'started'; id: string; requestId: string | null; captureUrl?: string }
  /** The principal asked to start again what the reply `id` started and did not leave. */
  | { type: 'restarted'; id: string }
  /** The principal allowed the proposal of the reply `id`; it is being performed. */
  | { type: 'allowed'; id: string }
  /**
   * The allowed action was performed and the next step left as `requestId`; `null` when it may
   * have been performed and nothing more is known.
   */
  | { type: 'performed'; id: string; requestId: string | null }
  /** The allowed action was performed and the task ended meanwhile: nothing follows it. */
  | { type: 'performed_last'; id: string }
  /**
   * The allowed action was not performed at all: it can be allowed again. `seen` is what the
   * shell read on the screen, and `text` says the action again with it (T1b).
   */
  | { type: 'not_performed'; id: string; seen?: string; text?: string }
  /** The principal stopped at the proposal of the reply `id`. */
  | { type: 'refused'; id: string }
  /** DK-11 AC13: the web search offered by the reply `id` is being added, was, or was not. */
  | { type: 'offer'; id: string; state: Offer['state']; why?: Offer['why'] }
  /**
   * DK-16: the stored conversation, oldest first; shown only while nothing else is. With
   * `replacing`, it replaces the messages asked over, if they are still the ones shown (B48):
   * only a message not sent stays, after it, since the daemon never had it.
   */
  | { type: 'history'; messages: ChatStoredMessage[]; replacing?: Message[] }
  /** DK-16: the daemon erased the stored conversation. */
  | { type: 'cleared' };

export const emptyConversation: Conversation = { connection: 'offline', messages: [] };

const deliveryOf = (outcome: Outcome): Delivery => {
  if (outcome.type === 'rejected') return 'not_sent';
  return outcome.type === 'unknown' ? 'unknown' : 'delivered';
};

const leftAs = (requestId: string | null): Pick<OwnMessage, 'delivery' | 'requestId'> => ({
  requestId,
  delivery: requestId === null ? 'not_sent' : 'pending',
});

/**
 * DK-11 AC13: the web search is offered in answer to a plain text the principal typed, which is
 * asked again once it is added.
 */
const offerFor = (
  messages: Message[],
  requestId: string,
  offer: string | undefined,
): Offer | null => {
  if (offer !== 'web_search') return null;
  const asked = messages.find(
    (message) => message.kind === 'own' && message.requestId === requestId,
  );
  if (asked?.kind !== 'own' || asked.attachments.length > 0 || asked.text.trim() === '')
    return null;
  return { ask: asked.text, state: 'offered', why: null };
};

/** DK-16: a stored message as the window shows it: handled, and nothing in it is armed again. */
const fromStore = (stored: ChatStoredMessage): Message => {
  const id = `stored:${stored.id}`;
  const door = stored.door === 'telegram' ? { door: 'telegram' as const } : {};
  if (stored.from === 'principal') {
    const { text } = stored;
    return {
      kind: 'own',
      id,
      text,
      attachments: [],
      delivery: 'delivered',
      requestId: null,
      ...door,
    };
  }
  const { channelRef, text } = stored;
  return {
    kind: 'bot',
    id,
    // A button without the reply it belongs to could not be answered.
    channelRef: channelRef ?? '',
    text,
    buttons: channelRef === null ? [] : stored.buttons,
    press: null,
    proposal: null,
    start: null,
    offer: null,
    ...door,
  };
};

const settle = (message: Message, requestId: string, delivery: Delivery): Message => {
  if (message.kind === 'own') {
    return message.requestId === requestId ? { ...message, delivery } : message;
  }
  if (message.start?.requestId === requestId) {
    return { ...message, start: { ...message.start, delivery } };
  }
  return message.press?.requestId === requestId
    ? { ...message, press: { ...message.press, delivery } }
    : message;
};

export const reduceConversation = (
  conversation: Conversation,
  action: ConversationAction,
): Conversation => {
  const { messages } = conversation;
  const mapped = (change: (message: Message) => Message): Conversation => ({
    ...conversation,
    messages: messages.map(change),
  });

  const answered = (id: string, press: Press | null): Conversation =>
    mapped((message) =>
      message.kind === 'bot' && message.id === id ? { ...message, press } : message,
    );

  const starting = (id: string, change: (start: Start) => Start): Conversation =>
    mapped((message) =>
      message.kind === 'bot' && message.id === id && message.start !== null
        ? { ...message, start: change(message.start) }
        : message,
    );

  switch (action.type) {
    case 'connection':
      return { ...conversation, connection: action.state };
    case 'said':
      return {
        ...conversation,
        messages: [
          ...messages,
          {
            kind: 'own',
            id: action.id,
            text: action.text,
            attachments: action.attachments,
            delivery: 'pending',
            requestId: null,
          },
        ],
      };
    case 'retried':
      return mapped((message) =>
        message.kind === 'own' && message.id === action.id
          ? { ...message, delivery: 'pending', requestId: null }
          : message,
      );
    case 'left':
      return mapped((message) =>
        message.kind === 'own' && message.id === action.id
          ? { ...message, ...leftAs(action.requestId) }
          : message,
      );
    case 'pressed':
      return mapped((message) =>
        message.kind === 'bot' && message.id === action.id
          ? { ...message, press: { data: action.data, ...leftAs(action.requestId) } }
          : message,
      );
    case 'outcome': {
      const settled = mapped((message) =>
        settle(message, action.requestId, deliveryOf(action.outcome)),
      );
      if (action.outcome.type !== 'reply') return settled;
      const { channelRef, text, buttons } = action.outcome.reply;
      return {
        ...settled,
        // The answer is always a new message, even to a press (DK-4 AC3).
        messages: [
          ...settled.messages,
          {
            kind: 'bot',
            id: channelRef,
            channelRef,
            text,
            buttons,
            press: null,
            proposal: action.proposal ?? null,
            offer: offerFor(settled.messages, action.requestId, action.outcome.reply.offer),
            // Pending from the start: the capture is taken before anything leaves.
            start:
              action.start === undefined
                ? null
                : { route: action.start, delivery: 'pending', requestId: null, captureUrl: null },
          },
        ],
      };
    }
    case 'started':
      return starting(action.id, (start) => ({
        ...start,
        ...leftAs(action.requestId),
        captureUrl: action.captureUrl ?? null,
      }));
    case 'offer':
      return mapped((message) =>
        message.kind === 'bot' && message.id === action.id && message.offer !== null
          ? {
              ...message,
              offer: { ...message.offer, state: action.state, why: action.why ?? null },
            }
          : message,
      );
    case 'restarted':
      return starting(action.id, (start) => ({
        ...start,
        delivery: 'pending',
        requestId: null,
        captureUrl: null,
      }));
    case 'allowed':
      return answered(action.id, { data: 'allow', delivery: 'pending', requestId: null });
    case 'performed':
      return answered(action.id, {
        data: 'allow',
        requestId: action.requestId,
        delivery: action.requestId === null ? 'unknown' : 'pending',
      });
    case 'performed_last':
      return answered(action.id, { data: 'allow', delivery: 'delivered', requestId: null });
    case 'not_performed':
      // Nothing was done: it can be allowed again, and from now on it is asked for.
      return mapped((message) =>
        message.kind === 'bot' && message.id === action.id
          ? {
              ...message,
              text: action.text ?? message.text,
              press: null,
              proposal:
                message.proposal === null
                  ? null
                  : {
                      ...message.proposal,
                      confirm: true,
                      seen: action.seen ?? message.proposal.seen,
                    },
            }
          : message,
      );
    case 'refused':
      return answered(action.id, { data: 'refuse', delivery: 'delivered', requestId: null });
    case 'history':
      if (action.replacing !== undefined) {
        // Something changed since it was asked: what is shown now may not be in it.
        if (messages !== action.replacing) return conversation;
        const notSent = messages.filter(
          (message) => message.kind === 'own' && message.delivery === 'not_sent',
        );
        return { ...conversation, messages: [...action.messages.map(fromStore), ...notSent] };
      }
      // A daemon that restarted while the window shows the conversation: it is already here.
      if (messages.length > 0) return conversation;
      return { ...conversation, messages: action.messages.map(fromStore) };
    case 'cleared':
      return { ...conversation, messages: [] };
  }
};

/** Whether the daemon still owes an answer to anything. */
export const isWaiting = (conversation: Conversation): boolean =>
  conversation.messages.some((message) =>
    message.kind === 'own'
      ? message.delivery === 'pending'
      : message.press?.delivery === 'pending' || message.start?.delivery === 'pending',
  );

/**
 * B48: whether the stored conversation may replace what is shown: nothing is owed an answer,
 * waits for "Permitir", is being added, or did not leave and would be lost (a look or a task a
 * reply started is never armed again from the store).
 */
export const isReplaceable = (conversation: Conversation): boolean =>
  !isWaiting(conversation) &&
  conversation.messages.every(
    (message) =>
      message.kind === 'own' ||
      ((message.proposal === null || message.press !== null) &&
        message.offer?.state !== 'adding' &&
        message.start?.delivery !== 'not_sent'),
  );
