// DK-3, DK-4: the window's end of the local channel. It owns the WebSocket protocol (request ids,
// what is still waiting for an answer, reconnecting) and nothing about how the chat looks, so it
// runs and is tested without React or a browser.
import {
  type ChatButtonPress,
  type ChatEvent,
  type ChatReceipt,
  type ChatReply,
  type ChatText,
  LOCAL_CHANNEL_PROTOCOL,
} from '@anomander/protocol';

/** A request as the window builds it; the client gives it its `id`. */
export type OutgoingRequest =
  | Omit<ChatText, 'id'>
  | Omit<ChatReceipt, 'id'>
  | Omit<ChatButtonPress, 'id'>;

export type ConnectionState = 'connecting' | 'open' | 'closed';

/** Why a request got no answer: the daemon refused its frame, or the connection went away. */
export type FailureCause = 'rejected' | 'disconnected';

export interface ChatClientListener {
  onConnection: (state: ConnectionState) => void;
  onReply: (requestId: string, reply: ChatReply) => void;
  onDone: (requestId: string) => void;
  onFailed: (requestId: string, cause: FailureCause) => void;
}

/** The part of a browser `WebSocket` the client uses, so tests can hand it a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface ChatClientOptions {
  url: string;
  /** DK-3 AC2: presented as the second subprotocol, never in the URL (AC3). */
  token: string;
  listener: ChatClientListener;
  createSocket?: (url: string, protocols: string[]) => SocketLike;
  newId?: () => string;
}

export interface ChatClient {
  /** Sends a request and returns its id, or `null` when the connection is not open. */
  send(request: OutgoingRequest): string | null;
  /** Closes the connection for good; whatever was waiting fails as `disconnected`. */
  close(): void;
}

const OPEN = 1;
/** Reconnecting waits 1 s, then doubles up to this, while the channel stays the same. */
const MAX_RETRY_MS = 10_000;

const browserSocket = (url: string, protocols: string[]): SocketLike =>
  new WebSocket(url, protocols) as unknown as SocketLike;

const parseEvent = (data: unknown): ChatEvent | null => {
  if (typeof data !== 'string') return null;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof event !== 'object' || event === null) return null;
  const type = (event as { type?: unknown }).type;
  return type === 'reply' || type === 'done' || type === 'rejected' ? (event as ChatEvent) : null;
};

export const createChatClient = (options: ChatClientOptions): ChatClient => {
  const { url, token, listener } = options;
  const createSocket = options.createSocket ?? browserSocket;
  const newId = options.newId ?? (() => crypto.randomUUID());
  /** Requests sent on the current socket and not answered yet. */
  const pending = new Set<string>();
  let socket: SocketLike;
  let closed = false;
  let retryMs = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const failPending = () => {
    const failed = [...pending];
    pending.clear();
    for (const id of failed) listener.onFailed(id, 'disconnected');
  };

  const settle = (id: string | null): boolean => (id === null ? false : pending.delete(id));

  const connect = () => {
    listener.onConnection('connecting');
    const current = createSocket(url, [LOCAL_CHANNEL_PROTOCOL, token]);
    socket = current;
    current.onopen = () => {
      retryMs = 1000;
      listener.onConnection('open');
    };
    current.onmessage = ({ data }) => {
      const event = parseEvent(data);
      if (event === null || !settle(event.inReplyTo)) return;
      if (event.type === 'reply') listener.onReply(event.inReplyTo, event);
      else if (event.type === 'done') listener.onDone(event.inReplyTo);
      else if (event.inReplyTo !== null) listener.onFailed(event.inReplyTo, 'rejected');
    };
    current.onclose = () => {
      if (closed || current !== socket) return;
      failPending();
      retry = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      listener.onConnection('connecting');
    };
    // A failed connection is followed by `close`, which handles it.
    current.onerror = () => {};
  };

  connect();

  return {
    send: (request) => {
      if (closed || socket.readyState !== OPEN) return null;
      const id = newId();
      pending.add(id);
      socket.send(JSON.stringify({ ...request, id }));
      return id;
    },
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(retry);
      socket.close();
      failPending();
      listener.onConnection('closed');
    },
  };
};
