// DK-3, DK-4: the window's side of the local channel. Framework-free: it owns the WebSocket, the
// request ids, the requests in flight and the reconnection, and tells its owner what happened to
// each request. The token lives only in this closure: never in a URL, a log or storage (DK-3 AC3).
import {
  CATEGORY_MODES,
  type ChatAction,
  type ChatButtonPress,
  type ChatComputer,
  type ChatEvent,
  type ChatExpense,
  type ChatExpenses,
  type ChatMemory,
  type ChatReceipt,
  type ChatReply,
  type ChatScreen,
  type ChatStoredMessage,
  type ChatText,
  EXPENSE_MODES,
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
  /** DK-18: the current memories, or `null` when they did not come, as `requestHistory`. */
  requestMemories(): Promise<ChatMemory[] | null>;
  /** DK-18: what ANOMANDER did, the latest first, or `null` when it did not come. */
  requestActions(): Promise<ChatAction[] | null>;
  /** DK-18: forgets one memory; what became of it, as `clearHistory`. */
  forgetMemory(memoryId: number): Promise<'done' | 'not_done' | 'unknown'>;
  /** DK-18: erases one action of the history; what became of it, as `clearHistory`. */
  forgetAction(actionId: number): Promise<'done' | 'not_done' | 'unknown'>;
  /**
   * DK-17: the expenses of `month` (`YYYY-MM`; absent, the daemon's current month). `failed`: the
   * daemon answered without them; `lost`: nothing was sent, or the connection was lost first.
   * It only reads, so asking again is always safe.
   */
  requestExpenses(month?: string): Promise<ChatExpenses | 'failed' | 'lost'>;
  dispose(): void;
}

const OPEN = 1;

/** What became of an erase `ask` sent: `unknown` when the connection was lost first. */
const erased = async (
  answered: Promise<ChatEvent | null | undefined>,
): Promise<'done' | 'not_done' | 'unknown'> => {
  const event = await answered;
  if (event === null) return 'unknown';
  return event?.type === 'done' ? 'done' : 'not_done';
};
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

const isKnown = <T extends string>(known: readonly T[], value: unknown): value is T =>
  known.some((one) => one === value);

/** DK-18: a memory only as the window can show it. */
const isMemory = (value: unknown): value is ChatMemory => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, text, mode } = value as Record<string, unknown>;
  return (
    typeof id === 'number' &&
    typeof text === 'string' &&
    isKnown(['declared', 'inferred'] as const, mode)
  );
};

/** DK-18: an action only as the window can show it. */
const isAction = (value: unknown): value is ChatAction => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, what, door, task, outcome, at } = value as Record<string, unknown>;
  return (
    typeof id === 'number' &&
    isKnown(['screen', 'computer', 'connect'] as const, what) &&
    isKnown(ONE_OF.door, door) &&
    typeof task === 'string' &&
    typeof outcome === 'string' &&
    typeof at === 'string'
  );
};

const isCount = (value: unknown): value is number => Number.isInteger(value);

/** DK-17: an expense only as the window can show it. */
const isExpense = (value: unknown): value is ChatExpense => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, date, merchant, category, totalCents, mode, categoryMode, origin, lines } =
    value as Record<string, unknown>;
  return (
    isCount(id) &&
    typeof date === 'string' &&
    (merchant === null || typeof merchant === 'string') &&
    (category === null || typeof category === 'string') &&
    isCount(totalCents) &&
    EXPENSE_MODES.some((known) => known === mode) &&
    (categoryMode === null || CATEGORY_MODES.some((known) => known === categoryMode)) &&
    (origin === 'text' || origin === 'receipt') &&
    isCount(lines)
  );
};

/** DK-17: the expenses of a month, keeping only the rows the window can show. */
const parseExpenses = (event: Record<string, unknown>): ChatExpenses | undefined => {
  const { inReplyTo, month, expenses, totalCents, pending } = event;
  const { count, totalCents: pendingCents } = (pending ?? {}) as Record<string, unknown>;
  if (
    typeof inReplyTo !== 'string' ||
    typeof month !== 'string' ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    !Array.isArray(expenses) ||
    !isCount(totalCents) ||
    !isCount(count) ||
    !isCount(pendingCents)
  ) {
    return undefined;
  }
  return {
    type: 'expenses',
    inReplyTo,
    month,
    expenses: expenses.filter(isExpense),
    totalCents,
    pending: { count, totalCents: pendingCents },
  };
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
    if (event?.type === 'memories') {
      const { memories } = event as { memories: unknown };
      return Array.isArray(memories)
        ? { ...(event as ChatEvent & { type: 'memories' }), memories: memories.filter(isMemory) }
        : undefined;
    }
    if (event?.type === 'actions') {
      const { actions } = event as { actions: unknown };
      return Array.isArray(actions)
        ? { ...(event as ChatEvent & { type: 'actions' }), actions: actions.filter(isAction) }
        : undefined;
    }
    if (event?.type === 'expenses') return parseExpenses(event as Record<string, unknown>);
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
  /** DK-16, DK-17, DK-18: the requests `ask` sent, in flight; `null` when the connection was lost. */
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
    request:
      | { type: 'history' | 'clear_history' | 'memories' | 'actions' }
      | { type: 'expenses'; month?: string }
      | { type: 'forget_memory'; memoryId: number }
      | { type: 'forget_action'; actionId: number },
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
      if (
        event.type === 'history' ||
        event.type === 'expenses' ||
        event.type === 'memories' ||
        event.type === 'actions'
      ) {
        return;
      }
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
    clearHistory: () => erased(ask({ type: 'clear_history' })),
    async requestMemories() {
      const event = await ask({ type: 'memories' });
      return event?.type === 'memories' ? event.memories : null;
    },
    async requestActions() {
      const event = await ask({ type: 'actions' });
      return event?.type === 'actions' ? event.actions : null;
    },
    forgetMemory: (memoryId) => erased(ask({ type: 'forget_memory', memoryId })),
    forgetAction: (actionId) => erased(ask({ type: 'forget_action', actionId })),
    async requestExpenses(month) {
      const event = await ask({ type: 'expenses', ...(month === undefined ? {} : { month }) });
      if (event === null || event === undefined) return 'lost';
      return event.type === 'expenses' ? event : 'failed';
    },
    dispose() {
      release();
      channel = null;
    },
  };
};
