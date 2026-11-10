// DK-4: the conversation as the window shows it. A pure reducer: it lives in memory only and is
// gone when the window is (never localStorage or disk).
import type { ChatButton, ComputerAction } from '@anomander/protocol';
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
  /** A task on the computer (DK-10): sent with a capture of the screen, never as a plain text. */
  task: boolean;
}

/**
 * An action ANOMANDER proposes on the computer (DK-10), waiting for the principal. Its `press`
 * is their answer: `allow`, pending until the next step is answered, or `refuse`.
 */
export interface Proposal {
  action: ComputerAction;
  /** The capture the action was planned on, as an object URL, to show where it would land. */
  captureUrl: string;
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
}

export type Message = OwnMessage | BotMessage;

export interface Conversation {
  connection: ConnectionState;
  messages: Message[];
}

export type ConversationAction =
  | { type: 'connection'; state: ConnectionState }
  /** The principal sent a message; it has not left yet. */
  | { type: 'said'; id: string; text: string; attachments: Attachment[]; task?: boolean }
  /** The principal asked to send a message that was not sent again. */
  | { type: 'retried'; id: string }
  /** A message left through the socket as `requestId`, or could not leave at all (`null`). */
  | { type: 'left'; id: string; requestId: string | null }
  /** A press on a button of the reply `id` left as `requestId`, or could not leave (`null`). */
  | { type: 'pressed'; id: string; data: string; requestId: string | null }
  /**
   * `proposal` is set only for the answer to a step of a task the principal asked for: an action
   * in any other reply is never offered.
   */
  | { type: 'outcome'; requestId: string; outcome: Outcome; proposal?: Proposal }
  /** The principal allowed the proposal of the reply `id`; it is being performed. */
  | { type: 'allowed'; id: string }
  /**
   * The allowed action was performed and the next step left as `requestId`; `null` when it may
   * have been performed and nothing more is known.
   */
  | { type: 'performed'; id: string; requestId: string | null }
  /** The allowed action was not performed at all: it can be allowed again. */
  | { type: 'not_performed'; id: string }
  /** The principal stopped at the proposal of the reply `id`. */
  | { type: 'refused'; id: string };

export const emptyConversation: Conversation = { connection: 'offline', messages: [] };

const deliveryOf = (outcome: Outcome): Delivery => {
  if (outcome.type === 'rejected') return 'not_sent';
  return outcome.type === 'unknown' ? 'unknown' : 'delivered';
};

const leftAs = (requestId: string | null): Pick<OwnMessage, 'delivery' | 'requestId'> => ({
  requestId,
  delivery: requestId === null ? 'not_sent' : 'pending',
});

const settle = (message: Message, requestId: string, delivery: Delivery): Message => {
  if (message.kind === 'own') {
    return message.requestId === requestId ? { ...message, delivery } : message;
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
            task: action.task ?? false,
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
          },
        ],
      };
    }
    case 'allowed':
      return answered(action.id, { data: 'allow', delivery: 'pending', requestId: null });
    case 'performed':
      return answered(action.id, {
        data: 'allow',
        requestId: action.requestId,
        delivery: action.requestId === null ? 'unknown' : 'pending',
      });
    case 'not_performed':
      return answered(action.id, null);
    case 'refused':
      return answered(action.id, { data: 'refuse', delivery: 'delivered', requestId: null });
  }
};

/** Whether the daemon still owes an answer to anything. */
export const isWaiting = (conversation: Conversation): boolean =>
  conversation.messages.some((message) =>
    message.kind === 'own' ? message.delivery === 'pending' : message.press?.delivery === 'pending',
  );
