// DK-3, DK-4: the window's side of the local channel. Framework-free: it owns the WebSocket, the
// request ids, the requests in flight and the reconnection, and tells its owner what happened to
// each request. The token lives only in this closure: never in a URL, a log or storage (DK-3 AC3).
import {
  type ChatButtonPress,
  type ChatComputer,
  type ChatEvent,
  type ChatReceipt,
  type ChatReply,
  type ChatScreen,
  type ChatStoredMessage,
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
  | Omit<ChatButtonPress, 'id'>
  | Omit<ChatScreen, 'id'>
  | Omit<ChatComputer, 'id'>;

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
  /**
   * DK-16: asks for the stored conversation; its messages, oldest first, or `null` when it did
   * not come: no open connection, rejected, or the connection was lost first.
   */
  requestHistory(): Promise<ChatStoredMessage[] | null>;
  /**
   * DK-16: erases the stored conversation. `not_done`: nothing was erased; `unknown`: the
   * connection was lost first, so it may have been.
   */
  clearHistory(): Promise<'done' | 'not_done' | 'unknown'>;
  dispose(): void;
}

const OPEN = 1;
/** A daemon that just started may not listen yet: retry soon, then back off. */
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

/** DK-13 AC2: a look or a task the window starts, with what was asked; anything else is not one. */
const routeOf = (route: unknown): ChatReply['route'] => {
  if (typeof route !== 'object' || route === null) return undefined;
  const { to, task } = route as Record<string, unknown>;
  if (to !== 'screen' && to !== 'computer') return undefined;
  return typeof task === 'string' && task.trim() !== '' ? { to, task } : undefined;
};

/** A reply keeps a route only as the window can start it. */
const withRoute = (reply: ChatReply): ChatReply => {
  if (!('route' in reply)) return reply;
  const { route, ...rest } = reply;
  const kept = routeOf(route);
  return kept === undefined ? rest : { ...rest, route: kept };
};

/** DK-11 AC13: a reply keeps an offer only as the window can add it. */
const withOffer = (reply: ChatReply): ChatReply => {
  if (!('offer' in reply) || reply.offer === 'web_search') return reply;
  const { offer: _unknown, ...rest } = reply;
  return rest;
};

const ONE_OF = { from: ['principal', 'anomander'], door: ['app', 'telegram'] } as const;

/** DK-16: a stored message only as the window can show it. */
const isStored = (value: unknown): value is ChatStoredMessage => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, from, door, text, buttons, channelRef, at } = value as Record<string, unknown>;
  return (
    typeof id === 'number' &&
    ONE_OF.from.some((known) => known === from) &&
    ONE_OF.door.some((known) => known === door) &&
    typeof text === 'string' &&
    Array.isArray(buttons) &&
    (channelRef === null || typeof channelRef === 'string') &&
    typeof at === 'string'
  );
};

const parseEvent = (data: unknown): ChatEvent | undefined => {
  if (typeof data !== 'string') return undefined;
  try {
    const event = JSON.parse(data) as Partial<ChatEvent> | null;
    if (event?.type === 'reply') return withOffer(withRoute(event as ChatReply));
    if (event?.type === 'history') {
      const { messages } = event as { messages: unknown };
      return Array.isArray(messages)
        ? { ...(event as ChatEvent & { type: 'history' }), messages: messages.filter(isStored) }
        : undefined;
    }
    return event?.type === 'done' || event?.type === 'rejected' ? (event as ChatEvent) : undefined;
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
  /** DK-16: the history and clear requests in flight; `null` when the connection was lost. */
  const awaited = new Map<string, (event: ChatEvent | null) => void>();

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
    for (const [requestId, resolve] of [...awaited]) {
      awaited.delete(requestId);
      resolve(null);
    }
  };

  /** Sends `request` and waits for its answer: `undefined` when nothing was sent. */
  const ask = (
    request: { type: 'history' } | { type: 'clear_history' },
  ): Promise<ChatEvent | null | undefined> => {
    if (socket === null || socket.readyState !== OPEN) return Promise.resolve(undefined);
    const id = crypto.randomUUID();
    const answered = new Promise<ChatEvent | null>((resolve) => awaited.set(id, resolve));
    socket.send(JSON.stringify({ ...request, id }));
    return answered;
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
      const waiting = awaited.get(event.inReplyTo);
      if (waiting !== undefined) {
        awaited.delete(event.inReplyTo);
        waiting(event);
        return;
      }
      if (event.type === 'history') return;
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
    async requestHistory() {
      const event = await ask({ type: 'history' });
      return event?.type === 'history' ? event.messages : null;
    },
    async clearHistory() {
      const event = await ask({ type: 'clear_history' });
      if (event === null) return 'unknown';
      return event?.type === 'done' ? 'done' : 'not_done';
    },
    dispose() {
      release();
      channel = null;
    },
  };
};
