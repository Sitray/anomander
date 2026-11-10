// The conversation as the window shows it, in memory only (never storage: the daemon too keeps
// recent turns in memory only). A pure reducer, so `useChat` holds no rules of its own.
import type { ChatButton, ChatReply } from '@anomander/protocol';
import { strings } from '../strings.ts';
import type { OutgoingRequest } from './chat-client.ts';

/** A file the principal attached, already in base64 as the receipt request carries it. */
export interface Attachment {
  name: string;
  mimeType: string;
  data: string;
}

export type DeliveryStatus = 'sending' | 'sent' | 'failed';

/** Something the principal sent: a text, or images with an optional caption. */
export interface PrincipalMessage {
  kind: 'principal';
  key: string;
  text: string | null;
  attachments: Attachment[];
  /** What was sent, to send it again on retry. */
  request: Exclude<OutgoingRequest, { type: 'button' }>;
  /** The id of the latest attempt; `null` when it could not even leave. */
  requestId: string | null;
  status: DeliveryStatus;
}

/** Whether a reply's buttons wait for the answer to a press, or were answered. */
export type Press =
  | { state: 'idle' }
  | { state: 'waiting'; requestId: string; index: number }
  | { state: 'answered'; index: number }
  | { state: 'failed' };

export interface AnomanderMessage {
  kind: 'anomander';
  /** The reply's `channelRef`, which a press on its buttons names. */
  key: string;
  text: string;
  buttons: ChatButton[];
  press: Press;
}

export type ChatMessage = PrincipalMessage | AnomanderMessage;

export interface ChatState {
  messages: ChatMessage[];
  /** What the live region reads out: the latest reply. */
  announcement: string;
}

export type ChatAction =
  | {
      type: 'sent';
      key: string;
      request: PrincipalMessage['request'];
      text: string | null;
      attachments: Attachment[];
      requestId: string | null;
    }
  | { type: 'resent'; key: string; requestId: string | null }
  | { type: 'pressed'; key: string; index: number; requestId: string | null }
  | { type: 'reply'; requestId: string; reply: ChatReply }
  | { type: 'done'; requestId: string }
  | { type: 'failed'; requestId: string };

export const initialChatState: ChatState = { messages: [], announcement: '' };

const statusOf = (requestId: string | null): DeliveryStatus =>
  requestId === null ? 'failed' : 'sending';

/** Settles whatever waited for `requestId`: a principal's message, or a press on a reply. */
const settle = (messages: ChatMessage[], requestId: string, ok: boolean): ChatMessage[] =>
  messages.map((message) => {
    if (message.kind === 'principal') {
      return message.requestId === requestId && message.status === 'sending'
        ? { ...message, status: ok ? 'sent' : 'failed' }
        : message;
    }
    const { press } = message;
    if (press.state !== 'waiting' || press.requestId !== requestId) return message;
    return {
      ...message,
      press: ok ? { state: 'answered', index: press.index } : { state: 'failed' },
    };
  });

export const chatReducer = (state: ChatState, action: ChatAction): ChatState => {
  switch (action.type) {
    case 'sent': {
      const { key, request, text, attachments, requestId } = action;
      const message: PrincipalMessage = {
        kind: 'principal',
        key,
        text,
        attachments,
        request,
        requestId,
        status: statusOf(requestId),
      };
      return { ...state, messages: [...state.messages, message] };
    }
    case 'resent':
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.kind === 'principal' && message.key === action.key
            ? { ...message, requestId: action.requestId, status: statusOf(action.requestId) }
            : message,
        ),
      };
    case 'pressed':
      return {
        ...state,
        messages: state.messages.map((message) => {
          if (message.kind !== 'anomander' || message.key !== action.key) return message;
          const press: Press =
            action.requestId === null
              ? { state: 'failed' }
              : { state: 'waiting', requestId: action.requestId, index: action.index };
          return { ...message, press };
        }),
      };
    case 'reply': {
      const { reply } = action;
      const message: AnomanderMessage = {
        kind: 'anomander',
        key: reply.channelRef,
        text: reply.text,
        buttons: reply.buttons,
        press: { state: 'idle' },
      };
      return {
        messages: [...settle(state.messages, action.requestId, true), message],
        announcement: strings.newReply(reply.text),
      };
    }
    case 'done':
      return { ...state, messages: settle(state.messages, action.requestId, true) };
    case 'failed':
      return { ...state, messages: settle(state.messages, action.requestId, false) };
  }
};
