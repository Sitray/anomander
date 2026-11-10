// DK-4: owns the chat's socket for the current channel. A restarted daemon hands a new channel,
// so the socket follows it; the conversation itself survives, in memory only.
import { type RefObject, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { LocalChannel } from '../shell.ts';
import { type ChatClient, type ConnectionState, createChatClient } from './chat-client.ts';
import {
  type AnomanderMessage,
  type Attachment,
  type ChatState,
  chatReducer,
  initialChatState,
  type PrincipalMessage,
} from './chat-state.ts';

export interface Chat extends ChatState {
  connection: ConnectionState;
  sendText: (text: string) => void;
  sendReceipt: (attachments: Attachment[], caption: string | null) => void;
  press: (reply: AnomanderMessage, index: number) => void;
  retry: (message: PrincipalMessage) => void;
}

const sendOn = (
  client: RefObject<ChatClient | null>,
  request: PrincipalMessage['request'],
): string | null => client.current?.send(request) ?? null;

export const useChat = (channel: LocalChannel | null): Chat => {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [connection, setConnection] = useState<ConnectionState>('closed');
  const client = useRef<ChatClient | null>(null);
  const keys = useRef(0);

  const url = channel?.url;
  const token = channel?.token;
  useEffect(() => {
    if (url === undefined || token === undefined) {
      setConnection('closed');
      return;
    }
    const current = createChatClient({
      url,
      token,
      listener: {
        onConnection: setConnection,
        onReply: (requestId, reply) => dispatch({ type: 'reply', requestId, reply }),
        onDone: (requestId) => dispatch({ type: 'done', requestId }),
        onFailed: (requestId) => dispatch({ type: 'failed', requestId }),
      },
    });
    client.current = current;
    return () => {
      client.current = null;
      current.close();
    };
  }, [url, token]);

  const sendText = useCallback((text: string) => {
    const request = { type: 'text', text } as const;
    const key = `local:${++keys.current}`;
    dispatch({
      type: 'sent',
      key,
      request,
      text,
      attachments: [],
      requestId: sendOn(client, request),
    });
  }, []);

  const sendReceipt = useCallback((attachments: Attachment[], caption: string | null) => {
    const request = {
      type: 'receipt',
      images: attachments.map(({ mimeType, data }) => ({ mimeType, data })),
      caption,
    } as const;
    const key = `local:${++keys.current}`;
    dispatch({
      type: 'sent',
      key,
      request,
      text: caption,
      attachments,
      requestId: sendOn(client, request),
    });
  }, []);

  const press = useCallback((reply: AnomanderMessage, index: number) => {
    const button = reply.buttons[index];
    if (button === undefined || !('data' in button)) return;
    const requestId = client.current?.send({
      type: 'button',
      data: button.data,
      channelRef: reply.key,
    });
    dispatch({ type: 'pressed', key: reply.key, index, requestId: requestId ?? null });
  }, []);

  const retry = useCallback((message: PrincipalMessage) => {
    if (message.status !== 'failed') return;
    dispatch({ type: 'resent', key: message.key, requestId: sendOn(client, message.request) });
  }, []);

  return { ...state, connection, sendText, sendReceipt, press, retry };
};
