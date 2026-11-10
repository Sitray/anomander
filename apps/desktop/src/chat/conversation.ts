// DK-4: the conversation as the window shows it. A pure reducer: it lives in memory only and is
// gone when the window is (never localStorage or disk).
import type { ChatButton } from '@anomander/protocol';
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
  | { type: 'outcome'; requestId: string; outcome: Outcome };

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
          { kind: 'bot', id: channelRef, channelRef, text, buttons, press: null },
        ],
      };
    }
  }
};

/** Whether the daemon still owes an answer to anything. */
export const isWaiting = (conversation: Conversation): boolean =>
  conversation.messages.some((message) =>
    message.kind === 'own' ? message.delivery === 'pending' : message.press?.delivery === 'pending',
  );
