// DK-4: binds the chat client to React. It owns the connection for as long as the chat is on
// screen and turns what the client reports into the conversation.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { LocalChannel } from '../shell.ts';
import { type Attachment, encodeAttachments } from './attachments.ts';
import { type ChatClient, createChatClient, type NewRequest } from './chat-client.ts';
import {
  type BotMessage,
  type Conversation,
  emptyConversation,
  type OwnMessage,
  reduceConversation,
} from './conversation.ts';

export interface Chat {
  conversation: Conversation;
  /** Sends a text, or the attachments as one receipt with the text as caption (DK-4 AC2). */
  say(text: string, attachments: Attachment[]): void;
  /** Sends again a message that was not sent. */
  retry(message: OwnMessage): void;
  /** Presses a button of `message` (DK-4 AC3). */
  press(message: BotMessage, data: string): void;
}

const requestFor = async (text: string, attachments: Attachment[]): Promise<NewRequest> =>
  attachments.length === 0
    ? { type: 'text', text }
    : {
        type: 'receipt',
        images: await encodeAttachments(attachments),
        caption: text === '' ? null : text,
      };

export const useChat = (channel: LocalChannel | null): Chat => {
  const [conversation, dispatch] = useReducer(reduceConversation, emptyConversation);
  const client = useRef<ChatClient | null>(null);

  useEffect(() => {
    const created = createChatClient({
      onConnection: (state) => dispatch({ type: 'connection', state }),
      onOutcome: (requestId, outcome) => dispatch({ type: 'outcome', requestId, outcome }),
    });
    client.current = created;
    return () => {
      created.dispose();
      client.current = null;
    };
  }, []);

  // A new snapshot with the same channel must not reconnect: depend on its values, not the object.
  const url = channel?.url ?? null;
  const token = channel?.token ?? null;
  useEffect(() => {
    client.current?.setChannel(url === null || token === null ? null : { url, token });
  }, [url, token]);

  const deliver = useCallback(async (id: string, text: string, attachments: Attachment[]) => {
    let requestId: string | null = null;
    try {
      requestId = client.current?.send(await requestFor(text, attachments)) ?? null;
    } catch {
      // A file that cannot be read never left: it is reported as not sent.
    }
    dispatch({ type: 'left', id, requestId });
  }, []);

  const say = useCallback(
    (text: string, attachments: Attachment[]) => {
      const id = crypto.randomUUID();
      dispatch({ type: 'said', id, text, attachments });
      void deliver(id, text, attachments);
    },
    [deliver],
  );

  const retry = useCallback(
    (message: OwnMessage) => {
      dispatch({ type: 'retried', id: message.id });
      void deliver(message.id, message.text, message.attachments);
    },
    [deliver],
  );

  const press = useCallback((message: BotMessage, data: string) => {
    const requestId =
      client.current?.send({ type: 'button', data, channelRef: message.channelRef }) ?? null;
    dispatch({ type: 'pressed', id: message.id, data, requestId });
  }, []);

  return { conversation, say, retry, press };
};
