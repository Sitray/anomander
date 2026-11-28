// DK-3, DK-4: the window's side of the local channel. Framework-free: it owns the WebSocket, the
// request ids, the requests in flight and the reconnection, and tells its owner what happened to
// each request. The token lives only in this closure: never in a URL, a log or storage (DK-3 AC3).
import {
  CATEGORY_MODES,
  type ChatAction,
  type ChatButtonPress,
  type ChatComputer,
  type ChatConnectionGrant,
  type ChatEvent,
  type ChatExpense,
  type ChatExpenses,
  type ChatMemory,
  type ChatNotice,
  type ChatReceipt,
  type ChatReply,
  type ChatScreen,
  type ChatStoredMessage,
  type ChatText,
  EXPENSE_MODES,
  LOCAL_CHANNEL_PROTOCOL,
  type Money,
  PROGRESS_PHASES,
  type ProgressPhase,
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
  /** `taken`: B81 (DK-4 AC7), a text a waiting login took; absent for any other `done`. */
  | { type: 'done'; taken?: 'login' }
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
  /** DK-19: what the daemon is doing for a request still owed its answer. */
  onProgress?: (requestId: string, phase: ProgressPhase) => void;
  /** DK-22: what ANOMANDER sent unasked; it answers no request. */
  onNotice?: (notice: ChatNotice) => void;
  /**
   * B81 (DK-4 AC7): whether a login started in Telegram waits for a pasted text now. `false`
   * whenever the connection is not open: the daemon says it again on the next one.
   */
  onLoginWaiting?: (waiting: boolean) => void;
  /** Defaults to the platform's `WebSocket`. */
  createSocket?: (url: string, protocols: string[]) => ChatSocket;
}

export interface ChatClient {
  /** Where to connect; `null` while the daemon is not running. Connects again when it changes. */
  setChannel(channel: LocalChannel | null): void;
  /** Sends `request` and returns its id, or `null` when nothing was sent: no open connection. */
  send(request: NewRequest): string | null;
  /**
   * DK-19: asks the daemon to stop the turn of `requestId`, still owed its answer; `false` when
   * nothing was sent. The answer to `requestId` still comes, and says whether it was stopped.
   */
  cancel(requestId: string): boolean;
  /**
   * DK-16: asks for the stored conversation; its messages, oldest first, or `null` when it did
   * not come: no open connection, rejected, or the connection was lost first.
   */
  requestHistory(): Promise<ChatStoredMessage[] | null>;
  /**
   * DK-16: erases the stored conversation. `not_done`: nothing was erased; `unknown`: the
   * connection was lost first, or no answer came within `CLEAR_LIMIT_MS`, so it may have been.
   * B80: `forgetMemory` and `forgetAction` share that limit; B84: `revokeConnectionGrant` too.
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
  /** DK-24: the tools allowed with "Permitir siempre", or `null` when they did not come. */
  requestConnectionGrants(): Promise<ChatConnectionGrant[] | null>;
  /** DK-24: "Quitar" on one of them; what became of it, as `clearHistory`. */
  revokeConnectionGrant(grantId: number): Promise<'done' | 'not_done' | 'unknown'>;
  /**
   * DK-17: the expenses of `month` (`YYYY-MM`; absent, the daemon's current month). `failed`: the
   * daemon answered without them; `lost`: nothing was sent, or the connection was lost first.
   * It only reads, so asking again is always safe.
   */
  requestExpenses(month?: string): Promise<ChatExpenses | 'failed' | 'lost'>;
  /**
   * DK-17 AC6: "Deshacer" or "Corregir" on a row of "Gastos"; the daemon's reply, as the expense's
   * button in the chat gets it. `not_sent`: no open connection; `rejected`: the daemon did not
   * take it, so nothing was done; `unknown`: the connection was lost first, so it may have been.
   */
  amendExpense(
    action: 'undo' | 'correct',
    expenseId: number,
  ): Promise<ChatReply | 'not_sent' | 'rejected' | 'unknown'>;
  /**
   * DK-21: today's AI calls and the daily limit, or `null` when they did not come, as
   * `requestHistory`. It only reads, so asking again is always safe.
   */
  requestAiUsage(): Promise<{ calls: number; limit: number } | null>;
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

/**
 * B55 (DK-16 AC4): how long "Sí, borrar" waits for the daemon's answer, which waits for a turn of
 * either door that runs: past it, it cannot know whether it was erased, as when the connection is
 * lost. A late answer changes nothing. B80: forgetting a memory or an action waits as long; B84:
 * so does "Quitar" on a connection grant.
 */
export const CLEAR_LIMIT_MS = 120_000;

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

/** B56: whether the reply erased the stored conversation, only as the daemon says it. */
const withErased = (reply: ChatReply): ChatReply => {
  if (!('erased' in reply) || reply.erased === 'conversation') return reply;
  const { erased: _unknown, ...rest } = reply;
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

/** DK-24: a "Permitir siempre" only as the window can show it. */
const isGrant = (value: unknown): value is ChatConnectionGrant => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, server, tool, at } = value as Record<string, unknown>;
  return (
    typeof id === 'number' &&
    typeof server === 'string' &&
    typeof tool === 'string' &&
    typeof at === 'string'
  );
};

const isCount = (value: unknown): value is number => Number.isInteger(value);

/**
 * DK-25: an ISO 4217 code as the daemon writes it, three capital letters. B78: the window's
 * `Intl` may know fewer currencies than the daemon's, and formats any such code with the code
 * itself (`12,30 XYZ`), so a code it does not know is never a reason to drop a row.
 */
const isCurrency = (code: unknown): code is string =>
  typeof code === 'string' && /^[A-Z]{3}$/.test(code);

/** DK-17: an expense only as the window can show it. */
const isExpense = (value: unknown): value is ChatExpense => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, date, merchant, category, totalCents, currency, mode, categoryMode, origin, lines } =
    value as Record<string, unknown>;
  return (
    isCount(id) &&
    typeof date === 'string' &&
    (merchant === null || typeof merchant === 'string') &&
    (category === null || typeof category === 'string') &&
    isCount(totalCents) &&
    isCurrency(currency) &&
    EXPENSE_MODES.some((known) => known === mode) &&
    (categoryMode === null || CATEGORY_MODES.some((known) => known === categoryMode)) &&
    (origin === 'text' || origin === 'receipt') &&
    isCount(lines)
  );
};

/** DK-25: a sum per currency, each entry cents in a currency code. */
const isSums = (value: unknown): value is Money[] =>
  Array.isArray(value) &&
  value.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const { cents, currency } = entry as Record<string, unknown>;
    return isCount(cents) && isCurrency(currency);
  });

/** DK-17: the expenses of a month, keeping only the rows the window can show. */
const parseExpenses = (event: Record<string, unknown>): ChatExpenses | undefined => {
  const { inReplyTo, month, expenses, totals, pending } = event;
  const { count, totals: pendingTotals } = (pending ?? {}) as Record<string, unknown>;
  if (
    typeof inReplyTo !== 'string' ||
    typeof month !== 'string' ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    !Array.isArray(expenses) ||
    !isSums(totals) ||
    !isCount(count) ||
    !isSums(pendingTotals)
  ) {
    return undefined;
  }
  return {
    type: 'expenses',
    inReplyTo,
    month,
    expenses: expenses.filter(isExpense),
    totals,
    pending: { count, totals: pendingTotals },
  };
};

/** DK-19: a progress event, only with a phase the window knows. */
const parseProgress = (data: unknown): { of: string; phase: ProgressPhase } | undefined => {
  if (typeof data !== 'string') return undefined;
  try {
    const { type, of, phase } = (JSON.parse(data) ?? {}) as Record<string, unknown>;
    if (type !== 'progress' || typeof of !== 'string' || !isKnown(PROGRESS_PHASES, phase)) {
      return undefined;
    }
    return { of, phase };
  } catch {
    return undefined;
  }
};

/** DK-22: a button only as the window can show it: one that comes back, or one that opens a link. */
const isButton = (value: unknown): value is ChatNotice['buttons'][number] => {
  if (typeof value !== 'object' || value === null) return false;
  const { label, data, url } = value as Record<string, unknown>;
  return typeof label === 'string' && (typeof data === 'string' || typeof url === 'string');
};

/** DK-22: a notice only as the window can show it. */
const parseNotice = (event: Record<string, unknown>): ChatNotice | undefined => {
  const { channelRef, text, buttons, sentAt } = event;
  if (typeof channelRef !== 'string' || channelRef === '' || typeof text !== 'string') {
    return undefined;
  }
  return {
    type: 'notice',
    inReplyTo: null,
    channelRef,
    text,
    buttons: Array.isArray(buttons) ? buttons.filter(isButton) : [],
    sentAt: typeof sentAt === 'string' ? sentAt : '',
  };
};

const parseEvent = (data: unknown): ChatEvent | undefined => {
  if (typeof data !== 'string') return undefined;
  try {
    const event = JSON.parse(data) as Partial<ChatEvent> | null;
    if (event?.type === 'reply') return withErased(withOffer(withRoute(event as ChatReply)));
    if (event?.type === 'notice') return parseNotice(event as Record<string, unknown>);
    if (event?.type === 'login_waiting') {
      const { waiting } = event as { waiting: unknown };
      return typeof waiting === 'boolean'
        ? { type: 'login_waiting', inReplyTo: null, waiting }
        : undefined;
    }
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
    if (event?.type === 'connection_grants') {
      const { grants } = event as { grants: unknown };
      return Array.isArray(grants)
        ? {
            ...(event as ChatEvent & { type: 'connection_grants' }),
            grants: grants.filter(isGrant),
          }
        : undefined;
    }
    if (event?.type === 'expenses') return parseExpenses(event as Record<string, unknown>);
    if (event?.type === 'ai_usage') {
      const { calls, limit } = event as Record<string, unknown>;
      return isCount(calls) && isCount(limit) ? (event as ChatEvent) : undefined;
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
    onProgress,
    onNotice,
    onLoginWaiting,
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
    // B81: what the daemon said of a waiting login holds only while its connection is open.
    if (state === 'open') onLoginWaiting?.(false);
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

  /**
   * Sends `request` and waits for its answer: `undefined` when nothing was sent. With `limitMs`,
   * `null` once that long passed without it, as when the connection is lost.
   */
  const ask = (
    request:
      | {
          type:
            | 'history'
            | 'clear_history'
            | 'memories'
            | 'actions'
            | 'ai_usage'
            | 'connection_grants';
        }
      | { type: 'revoke_connection_grant'; grantId: number }
      | { type: 'expenses'; month?: string }
      | { type: 'forget_memory'; memoryId: number }
      | { type: 'forget_action'; actionId: number }
      | { type: 'undo_expense' | 'correct_expense'; expenseId: number },
    limitMs?: number,
  ): Promise<ChatEvent | null | undefined> => {
    if (socket === null || socket.readyState !== OPEN) return Promise.resolve(undefined);
    const id = crypto.randomUUID();
    const answered = new Promise<ChatEvent | null>((resolve) => {
      if (limitMs === undefined) {
        awaited.set(id, resolve);
        return;
      }
      const limit = setTimeout(() => {
        awaited.delete(id);
        resolve(null);
      }, limitMs);
      awaited.set(id, (event) => {
        clearTimeout(limit);
        resolve(event);
      });
    });
    socket.send(JSON.stringify({ ...request, id }));
    return answered;
  };

  /**
   * B55, B80, B84: an erase that waits for the daemon's answer at most `CLEAR_LIMIT_MS`; past it,
   * it cannot know whether it was erased, as when the connection is lost.
   */
  const eraseWithin = (
    request:
      | { type: 'clear_history' }
      | { type: 'forget_memory'; memoryId: number }
      | { type: 'forget_action'; actionId: number }
      | { type: 'revoke_connection_grant'; grantId: number },
  ): Promise<'done' | 'not_done' | 'unknown'> => erased(ask(request, CLEAR_LIMIT_MS));

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
      const progress = parseProgress(message.data);
      if (progress !== undefined) {
        if (inFlight.has(progress.of)) onProgress?.(progress.of, progress.phase);
        return;
      }
      const event = parseEvent(message.data);
      if (event?.type === 'notice') {
        onNotice?.(event);
        return;
      }
      if (event?.type === 'login_waiting') {
        onLoginWaiting?.(event.waiting);
        return;
      }
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
        event.type === 'actions' ||
        event.type === 'ai_usage' ||
        event.type === 'connection_grants'
      ) {
        return;
      }
      settle(
        event.inReplyTo,
        event.type === 'reply'
          ? { type: 'reply', reply: event }
          : event.type === 'done' && event.taken === 'login'
            ? { type: 'done', taken: 'login' }
            : { type: event.type },
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
    cancel(requestId) {
      if (socket === null || socket.readyState !== OPEN || !inFlight.has(requestId)) return false;
      // Its `done` names an id never in flight, so it settles nothing.
      socket.send(JSON.stringify({ type: 'cancel', id: crypto.randomUUID(), target: requestId }));
      return true;
    },
    async requestHistory() {
      const event = await ask({ type: 'history' });
      return event?.type === 'history' ? event.messages : null;
    },
    clearHistory: () => eraseWithin({ type: 'clear_history' }),
    async requestMemories() {
      const event = await ask({ type: 'memories' });
      return event?.type === 'memories' ? event.memories : null;
    },
    async requestActions() {
      const event = await ask({ type: 'actions' });
      return event?.type === 'actions' ? event.actions : null;
    },
    forgetMemory: (memoryId) => eraseWithin({ type: 'forget_memory', memoryId }),
    forgetAction: (actionId) => eraseWithin({ type: 'forget_action', actionId }),
    async requestConnectionGrants() {
      const event = await ask({ type: 'connection_grants' });
      return event?.type === 'connection_grants' ? event.grants : null;
    },
    revokeConnectionGrant: (grantId) => eraseWithin({ type: 'revoke_connection_grant', grantId }),
    async requestExpenses(month) {
      const event = await ask({ type: 'expenses', ...(month === undefined ? {} : { month }) });
      if (event === null || event === undefined) return 'lost';
      return event.type === 'expenses' ? event : 'failed';
    },
    async amendExpense(action, expenseId) {
      const event = await ask({
        type: action === 'undo' ? 'undo_expense' : 'correct_expense',
        expenseId,
      });
      if (event === null) return 'unknown';
      if (event === undefined) return 'not_sent';
      return event.type === 'reply' ? event : 'rejected';
    },
    async requestAiUsage() {
      const event = await ask({ type: 'ai_usage' });
      return event?.type === 'ai_usage' ? { calls: event.calls, limit: event.limit } : null;
    },
    dispose() {
      release();
      channel = null;
    },
  };
};
