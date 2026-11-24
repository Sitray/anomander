// DK-3, DK-4 (docs/desktop-prd.md): the messages of the local channel between the desktop app
// and the daemon, a WebSocket on `127.0.0.1`. Each message is one JSON text frame.
//
// The app presents its token when it connects, as the second WebSocket subprotocol:
// `new WebSocket(url, [LOCAL_CHANNEL_PROTOCOL, token])`. It never travels in the URL.

export const LOCAL_CHANNEL_PROTOCOL = 'anomander.v1';

/** One image the principal dropped in the chat (DK-4 AC2). */
export interface ChatImage {
  mimeType: string;
  /** The file's bytes, in base64. */
  data: string;
}

/** A text the principal typed (DK-4 AC1). */
export interface ChatText {
  type: 'text';
  /** Chosen by the app, unique in its connection; the daemon's answer names it. */
  id: string;
  text: string;
  /** The `channelRef` of the reply this text answers, if any (R-17 AC2). */
  replyTo?: string;
}

/** One file, or several dropped together, as a receipt (DK-4 AC2; R-3 AC4 for several). */
export interface ChatReceipt {
  type: 'receipt';
  id: string;
  images: ChatImage[];
  caption: string | null;
}

/** A press on a button of a reply (DK-4 AC3). */
export interface ChatButtonPress {
  type: 'button';
  id: string;
  /** The button's `data`. */
  data: string;
  /** The `channelRef` of the reply that carries the button. */
  channelRef: string;
}

/**
 * A question about what is on the principal's screen, with the capture the app took when they
 * asked. Only the app can send it: the capture is taken on their machine, at their request.
 */
export interface ChatScreen {
  type: 'screen';
  id: string;
  /** What the principal asks about the screen. */
  text: string;
  image: ChatImage;
}

/** The most steps one task may take; after them the daemon stops proposing (DK-10 AC4). */
export const MAX_COMPUTER_STEPS = 12;

/** The keys a `key` action may press, besides one letter or digit. */
export const COMPUTER_KEYS = [
  'enter',
  'tab',
  'escape',
  'backspace',
  'space',
  'up',
  'down',
  'left',
  'right',
] as const;
export const COMPUTER_MODIFIERS = ['cmd', 'shift', 'alt', 'ctrl'] as const;
export type ComputerModifier = (typeof COMPUTER_MODIFIERS)[number];

/**
 * One thing ANOMANDER proposes to do on the principal's computer (DK-10). The daemon only
 * proposes it: the app performs it, after the principal allowed it when it is a step of care.
 * `x` and `y` are a point of the capture, from 0 to 1000 across its width and its height.
 */
export type ComputerAction =
  /** `target` is what the processor says is there: a claim, shown next to the capture itself. */
  | { kind: 'click'; x: number; y: number; double: boolean; target: string }
  | { kind: 'type'; text: string }
  /** `key` is one of `COMPUTER_KEYS`, or one letter or digit. */
  | { kind: 'key'; key: string; modifiers: ComputerModifier[] }
  | { kind: 'scroll'; x: number; y: number; direction: 'up' | 'down' };

/**
 * A task on the principal's computer, one step at a time: what they asked, the screen as it is
 * now, and what was already done for it. Only the app can send it.
 */
export interface ChatComputer {
  type: 'computer';
  id: string;
  task: string;
  image: ChatImage;
  /** The steps already performed, as the daemon described them, oldest first. */
  done: string[];
}

/**
 * A task for the servers the principal connected (DK-11). The daemon runs it: a call that needs
 * their permission comes back as a reply with "Permitir" and "Detener" buttons. Only the app
 * can send it.
 */
export interface ChatConnect {
  type: 'connect';
  id: string;
  task: string;
}

/**
 * DK-16: the stored conversation, oldest first, at most `limit` messages (default and maximum
 * `HISTORY_LIMIT`). The app asks for it when its chat is empty; answered with a `ChatHistory`.
 */
export interface ChatHistoryRequest {
  type: 'history';
  id: string;
  limit?: number;
}

/**
 * DK-16: erases the stored conversation and the recent turns, after the principal confirmed it in
 * the app. Answered with `done`.
 */
export interface ChatClearHistory {
  type: 'clear_history';
  id: string;
}

/**
 * DK-17: the expenses of one month, for the window's "Gastos" screen. Answered with a
 * `ChatExpenses`. Only reads: nothing is written.
 */
export interface ChatExpensesRequest {
  type: 'expenses';
  id: string;
  /** `YYYY-MM`; absent, the current month in the daemon's `TZ`. */
  month?: string;
}

export type ChatRequest =
  | ChatText
  | ChatReceipt
  | ChatButtonPress
  | ChatScreen
  | ChatComputer
  | ChatConnect
  | ChatHistoryRequest
  | ChatClearHistory
  | ChatExpensesRequest;

/** DK-16: the most stored messages a `history` request returns. */
export const HISTORY_LIMIT = 500;

/** A button under a reply: it comes back as a `ChatButtonPress`, or opens `url`. */
export type ChatButton = { label: string; data: string } | { label: string; url: string };

/** The daemon's answer to the request `inReplyTo`. */
export interface ChatReply {
  type: 'reply';
  inReplyTo: string;
  /** This reply's own reference: `desktop:<uuid>`. */
  channelRef: string;
  text: string;
  buttons: ChatButton[];
  sentAt: string;
  /** The action `text` proposes, in answer to a `computer` request; absent when it proposes none. */
  computer?: ComputerAction;
  /**
   * With `computer`: `false` when the action is routine and may be performed without asking;
   * anything else means the principal must allow it first (DK-10 AC1).
   */
  confirm?: boolean;
  /**
   * DK-13 AC2: in answer to a `text` request, the look or the task on the computer the app starts
   * now, as if the principal had asked for it with a `screen` or `computer` request.
   */
  route?: { to: 'screen' | 'computer'; task: string };
  /**
   * DK-11 AC13: the connection `text` says is missing; the app offers to add it in one press and
   * then sends the request again.
   */
  offer?: 'web_search';
}

/** The request `inReplyTo` was handled and has no reply. */
export interface ChatDone {
  type: 'done';
  inReplyTo: string;
}

/** A frame that is not a `ChatRequest`. Nothing was done with it. */
export interface ChatRejected {
  type: 'rejected';
  /** The frame's `id` when it had one. */
  inReplyTo: string | null;
}

/**
 * DK-16: one message of the stored conversation, from either door. No image is stored: a receipt
 * is its `[foto de ticket]` line, a press its `[botón: …]` line.
 */
export interface ChatStoredMessage {
  /** Ascending, never reused. */
  id: number;
  from: 'principal' | 'anomander';
  door: 'app' | 'telegram';
  text: string;
  /** Only on a message from ANOMANDER; `[]` otherwise. */
  buttons: ChatButton[];
  /** The reply's own reference, so a press on a stored button still resolves; `null` for the principal. */
  channelRef: string | null;
  /** ISO 8601, UTC. */
  at: string;
}

/** DK-16: the answer to a `history` request. */
export interface ChatHistory {
  type: 'history';
  inReplyTo: string;
  messages: ChatStoredMessage[];
}

/** The epistemic mode of an expense, as the `gastos` view gives it (`modo`, principle 2). */
export const EXPENSE_MODES = ['declared', 'inferred', 'corroborated', 'confirmed'] as const;
export type ExpenseMode = (typeof EXPENSE_MODES)[number];

/**
 * How the category of an expense was chosen (`expenses.category_basis`, R-5): the principal said
 * it, a policy of theirs gave it, or the processor inferred it.
 */
export const CATEGORY_MODES = ['declared', 'policy', 'inferred'] as const;
export type CategoryMode = (typeof CATEGORY_MODES)[number];

/** DK-17: one row of the `gastos` view (RA-1), with its purchase lines counted. */
export interface ChatExpense {
  id: number;
  /** `fecha`: `YYYY-MM-DD` in `TZ`. */
  date: string;
  merchant: string | null;
  category: string | null;
  totalCents: number;
  /** `modo`: the view gives it for the whole expense, not field by field. */
  mode: ExpenseMode;
  /** How its category was chosen; `null` without a category or a recorded basis. */
  categoryMode: CategoryMode | null;
  /** `origen`: `texto` or `ticket`. */
  origin: 'text' | 'receipt';
  /** Its rows in `lineas_de_compra`: `0` for a typed expense. */
  lines: number;
}

/** DK-17: the answer to an `expenses` request. */
export interface ChatExpenses {
  type: 'expenses';
  inReplyTo: string;
  /** `YYYY-MM`: the month asked, or the current one when none was. */
  month: string;
  /** The month's current expenses, by day and then id. */
  expenses: ChatExpense[];
  /** The sum of `expenses`, computed by code. */
  totalCents: number;
  /** `pendientes_de_confirmar`: every pending expense, whatever its month, never in the total. */
  pending: { count: number; totalCents: number };
}

export type ChatEvent = ChatReply | ChatDone | ChatRejected | ChatHistory | ChatExpenses;
