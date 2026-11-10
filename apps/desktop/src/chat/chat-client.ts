// DK-3, DK-4: the window's side of the local channel. Framework-free: it owns the WebSocket, the
// request ids, the requests in flight and the reconnection, and tells its owner what happened to
// each request. The token lives only in this closure: never in a URL, a log or storage (DK-3 AC3).
import {
  type ChatButtonPress,
  type ChatEvent,
  type ChatReceipt,
  type ChatReply,
  type ChatText,
  LOCAL_CHANNEL_PROTOCOL,
} from '@anomander/protocol';
import type { LocalChannel } from '../shell.ts';

/** `offline`: there is no channel. `connecting`: there is one, and no open socket yet. */
export type ConnectionState = 'offline' | 'connecting' | 'open';

/**
 * What became of a request that left through the socket:
 * - `reply`, `done`: the daemon handled it;
 * - `rejected`: the daemon did nothing with it, so sending it again is safe;
 * - `unknown`: the connection was lost first. The daemon may have handled it (and registered an
 *   expense), so sending it again is NOT safe.
 */
export type Outcome =
  | { type: 'reply'; reply: ChatReply }
  | { type: 'done' }
  | { type: 'rejected' }
  | { type: 'unknown' };

/** A request without its `id`, which the client chooses. */
export type NewRequest =
  | Omit<ChatText, 'id'>
  | Omit<ChatReceipt, 'id'>
  | Omit<ChatButtonPress, 'id'>;

/** The part of `WebSocket` the client uses, so a test can hand it a fake. */
export type ChatSocket = Pick<
  WebSocket,
  'send' | 'close' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'
> & { readonly readyState: number };

export interface ChatClientOptions {
  onConnection: (state: ConnectionState) => void;
  /** Called exactly once for every request `send` returned an id for. */
  onOutcome: (requestId: string, outcome: Outcome) => void;
  /** Defaults to the platform's `WebSocket`. */
  createSocket?: (url: string, protocols: string[]) => ChatSocket;
}

export interface ChatClient {
  /** Where to connect; `null` while the daemon is not running. Connects again when it changes. */
  setChannel(channel: LocalChannel | null): void;
  /** Sends `request` and returns its id, or `null` when nothing was sent: no open connection. */
  send(request: NewRequest): string | null;
  dispose(): void;
}

const OPEN = 1;
/** A daemon that just started may not listen yet: retry soon, then back off. */
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

const parseEvent = (data: unknown): ChatEvent | undefined => {
  if (typeof data !== 'string') return undefined;
  try {
    const event = JSON.parse(data) as Partial<ChatEvent> | null;
    return event?.type === 'reply' || event?.type === 'done' || event?.type === 'rejected'
      ? (event as ChatEvent)
      : undefined;
  } catch {
    return undefined;
  }
};

export const createChatClient = (options: ChatClientOptions): ChatClient => {
  const {
    onConnection,
    onOutcome,
    createSocket = (url, protocols) => new WebSocket(url, protocols),
  } = options;

  let channel: LocalChannel | null = null;
  let socket: ChatSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let state: ConnectionState = 'offline';
  const inFlight = new Set<string>();

  const report = (next: ConnectionState): void => {
    if (next === state) return;
    state = next;
    onConnection(next);
  };

  const settle = (requestId: string, outcome: Outcome): void => {
    if (inFlight.delete(requestId)) onOutcome(requestId, outcome);
  };

  /** The socket is gone: whether the daemon handled what was in flight cannot be known. */
  const loseInFlight = (): void => {
    for (const requestId of [...inFlight]) settle(requestId, { type: 'unknown' });
  };

  /** Lets go of the current socket without hearing from it again. */
  const release = (): void => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (socket === null) return;
    const released = socket;
    socket = null;
    released.onopen = released.onmessage = released.onclose = released.onerror = null;
    released.close();
    loseInFlight();
  };

  const connect = (): void => {
    if (channel === null) return;
    report('connecting');
    const opened = createSocket(channel.url, [LOCAL_CHANNEL_PROTOCOL, channel.token]);
    socket = opened;
    opened.onopen = () => {
      failures = 0;
      report('open');
    };
    opened.onmessage = (message) => {
      const event = parseEvent(message.data);
      // A `rejected` without an id cannot be one of ours: every request carries its id.
      if (event === undefined || event.inReplyTo === null) return;
      settle(
        event.inReplyTo,
        event.type === 'reply' ? { type: 'reply', reply: event } : { type: event.type },
      );
    };
    opened.onclose = () => {
      socket = null;
      opened.onopen = opened.onmessage = opened.onclose = opened.onerror = null;
      loseInFlight();
      report('connecting');
      const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
      failures += 1;
      retryTimer = setTimeout(connect, delay);
    };
  };

  return {
    setChannel(next) {
      if (next?.url === channel?.url && next?.token === channel?.token) return;
      release();
      channel = next === null ? null : { url: next.url, token: next.token };
      failures = 0;
      if (channel === null) report('offline');
      else connect();
    },
    send(request) {
      if (socket === null || socket.readyState !== OPEN) return null;
      const id = crypto.randomUUID();
      inFlight.add(id);
      socket.send(JSON.stringify({ ...request, id }));
      return id;
    },
    dispose() {
      release();
      channel = null;
    },
  };
};
