// DK-3, DK-4 (docs/desktop-prd.md): the messages of the local channel between the desktop app
// and the daemon, a WebSocket on `127.0.0.1`. Each message is one JSON text frame.
//
// The app presents its token when it connects, as the second WebSocket subprotocol:
// `new WebSocket(url, [LOCAL_CHANNEL_PROTOCOL, token])`. It never travels in the URL.

import type { Money } from './money.ts';

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
 * their permission comes back as a reply with "Permitir" and "Detener" buttons, and "Permitir
 * siempre" between them when it can be granted (DK-24). Only the app
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

/** DK-18: the current memories (R-23 AC5), for the window's "Memoria". Answered with `ChatMemories`. */
export interface ChatMemoriesRequest {
  type: 'memories';
  id: string;
}

/**
 * DK-18: forgets one memory, after the principal confirmed it in the window, as a confirmed
 * "olvida" does (R-23 AC6, AC7; DK-16 AC5). Answered with `done`.
 */
export interface ChatForgetMemory {
  type: 'forget_memory';
  id: string;
  /** The memory's `id`, as `ChatMemories` gave it. */
  memoryId: number;
}

/** DK-18: what ANOMANDER did (DK-14), for the window's "Memoria". Answered with `ChatActions`. */
export interface ChatActionsRequest {
  type: 'actions';
  id: string;
}

/** DK-18: erases one action of the history for real, after the principal confirmed it. Answered with `done`. */
export interface ChatForgetAction {
  type: 'forget_action';
  id: string;
  /** The action's `id`, as `ChatActions` gave it. */
  actionId: number;
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

/**
 * DK-17 AC6: "Deshacer" on a row of "Gastos", once the principal confirmed it in the window. The
 * daemon answers the expense's `amend_expense` question as its "Deshacer" in the chat does
 * (R-7 AC5), in the chat's turn, and keeps the press and its reply in the stored conversation.
 * Answered with a `ChatReply`: S-100 or S-101, S-19 when the expense is no longer current.
 */
export interface ChatUndoExpense {
  type: 'undo_expense';
  id: string;
  /** The expense's `id`, as `ChatExpenses` gave it. */
  expenseId: number;
}

/**
 * DK-17 AC6: "Corregir" on a row of "Gastos": the daemon answers as the chat's "Corregir" does
 * (R-7 AC6), so the principal's next text is the correction. Answered with a `ChatReply`: S-7 with
 * `awaitsText`, or S-19 when the expense is no longer current.
 */
export interface ChatCorrectExpense {
  type: 'correct_expense';
  id: string;
  /** The expense's `id`, as `ChatExpenses` gave it. */
  expenseId: number;
}

/**
 * DK-19: stops the turn of the request `target`, as far as the daemon can safely stop it: a
 * processor call that runs is aborted, none starts after it, and a task with connections stops
 * before its next step. What was already done is not undone. Only a `text`, `screen` or `connect`
 * request can be stopped; the reply to it says it was stopped (S-130) unless it had already ended.
 * Answered with `done` at once, whatever became of the target.
 */
export interface ChatCancel {
  type: 'cancel';
  id: string;
  /** The `id` of the request whose turn to stop. */
  target: string;
}

/**
 * DK-21: today's processor calls and the daily limit (R-12), for the window. Answered with a
 * `ChatAiUsage`. Only reads: asking counts no call.
 */
export interface ChatAiUsageRequest {
  type: 'ai_usage';
  id: string;
}

/**
 * DK-24 AC3: the tools the principal allowed with "Permitir siempre", for the window's
 * "Conexiones". Answered with `ChatConnectionGrants`. Only reads.
 */
export interface ChatConnectionGrantsRequest {
  type: 'connection_grants';
  id: string;
}

/** DK-24 AC3: takes one "Permitir siempre" back ("Quitar"). Answered with `done`. */
export interface ChatRevokeConnectionGrant {
  type: 'revoke_connection_grant';
  id: string;
  /** The grant's `id`, as `ChatConnectionGrants` gave it. */
  grantId: number;
}

/**
 * DK-23 AC4: "Probar" in the setup screen: one minimal call to the saved model
 * (`ANOMANDER_MODEL`), counted against the daily AI budget (R-12). Answered with a `ChatProbe`.
 */
export interface ChatProbeModel {
  type: 'probe_model';
  id: string;
}

export type ChatRequest =
  | ChatAiUsageRequest
  | ChatText
  | ChatReceipt
  | ChatButtonPress
  | ChatScreen
  | ChatComputer
  | ChatConnect
  | ChatHistoryRequest
  | ChatClearHistory
  | ChatMemoriesRequest
  | ChatForgetMemory
  | ChatActionsRequest
  | ChatForgetAction
  | ChatExpensesRequest
  | ChatUndoExpense
  | ChatCorrectExpense
  | ChatConnectionGrantsRequest
  | ChatRevokeConnectionGrant
  | ChatProbeModel
  | ChatCancel;

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
  /**
   * R-7 AC1, AC6: the press this answers left a decision waiting for the principal's text, so
   * their next text is its answer, written in the chat (DK-17 AC6); absent otherwise.
   */
  awaitsText?: true;
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

/** DK-18: one current memory (R-23): what the principal said (`declared`) or what was deduced (`inferred`). */
export interface ChatMemory {
  id: number;
  text: string;
  mode: 'declared' | 'inferred';
}

/** DK-18: the answer to a `memories` request, in the order they were remembered. */
export interface ChatMemories {
  type: 'memories';
  inReplyTo: string;
  memories: ChatMemory[];
}

/** DK-18: one action of the history (DK-14 AC2), without its steps or calls. */
export interface ChatAction {
  id: number;
  what: 'screen' | 'computer' | 'connect';
  door: 'app' | 'telegram';
  /** The principal's words: the question about the screen or the task. */
  task: string;
  /** How it ended, as a code word. */
  outcome: string;
  /** When it ended: ISO 8601, UTC. */
  at: string;
}

/** DK-18: the answer to an `actions` request, the latest first. */
export interface ChatActions {
  type: 'actions';
  inReplyTo: string;
  actions: ChatAction[];
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
  /** ISO 4217: the currency `totalCents` is in, read beside the view (DK-25). */
  currency: string;
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
  /**
   * The sum of `expenses`, computed by code, one entry per currency, never added across them
   * (DK-25); zero in the principal's currency when the month has none.
   */
  totals: Money[];
  /** Every pending expense, whatever its month, never in the total; summed as `totals`. */
  pending: { count: number; totals: Money[] };
}

/**
 * DK-22: what ANOMANDER sends unasked (a reminder, the morning digest, the weekly summary, any
 * other message of `notify`), pushed to every open connection of the app. It answers no request.
 * A press on one of its buttons comes back as a `ChatButtonPress` with this `channelRef`.
 */
export interface ChatNotice {
  type: 'notice';
  /** It answers no request. */
  inReplyTo: null;
  /** This message's own reference: `desktop:<uuid>`. */
  channelRef: string;
  text: string;
  buttons: ChatButton[];
  sentAt: string;
}

/** DK-21: the answer to an `ai_usage` request. */
export interface ChatAiUsage {
  type: 'ai_usage';
  inReplyTo: string;
  /** The processor calls counted today in `TZ`. */
  calls: number;
  /** `ANOMANDER_DAILY_AI_CALL_LIMIT`. */
  limit: number;
}

/** DK-24: a tool the principal allowed always, for that server as it is configured now. */
export interface ChatConnectionGrant {
  id: number;
  /** The server's name in `mcp.json`. */
  server: string;
  tool: string;
  /** When the principal pressed "Permitir siempre": ISO 8601, UTC. */
  at: string;
}

/** DK-24: the answer to a `connection_grants` request, by server and then tool. */
export interface ChatConnectionGrants {
  type: 'connection_grants';
  inReplyTo: string;
  grants: ChatConnectionGrant[];
}

/**
 * DK-23 AC4: how a probe of the model ended, never the provider's own words, which can quote the
 * key: `ok`; `model_unset`, `vision_model_unset` (the model is saved, the one for photos is not) or
 * `model_unknown` while the setup names no usable model;
 * `not_connected` without a key or a login; `budget_exhausted` (R-12, no call made); and from the
 * call itself `key_refused`, `model_unavailable`, `provider_limit`, `timed_out` or `failed`.
 */
export const PROBE_OUTCOMES = [
  'ok',
  'model_unset',
  'vision_model_unset',
  'model_unknown',
  'not_connected',
  'budget_exhausted',
  'key_refused',
  'model_unavailable',
  'provider_limit',
  'timed_out',
  'failed',
] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/**
 * DK-23 AC4: the answer to a `probe_model` request. The window asks it on a connection of its own,
 * so it is not one of the chat's `ChatEvent`s.
 */
export interface ChatProbe {
  type: 'probe';
  inReplyTo: string;
  outcome: ProbeOutcome;
}

export type ChatEvent =
  | ChatAiUsage
  | ChatReply
  | ChatNotice
  | ChatDone
  | ChatRejected
  | ChatHistory
  | ChatMemories
  | ChatActions
  | ChatExpenses
  | ChatConnectionGrants;

/**
 * DK-19: what a turn the daemon is running is doing now, so the window can say it: a task with
 * connections calling a tool (`connection`), or the web search's (`web_search`). Optional: a
 * window that ignores it loses nothing, and a turn may end without any.
 */
export const PROGRESS_PHASES = ['connection', 'web_search'] as const;
export type ProgressPhase = (typeof PROGRESS_PHASES)[number];

/**
 * DK-19: sent while the request `of` is still owed its answer; never an answer itself, so it
 * names the request in `of`, not `inReplyTo`.
 */
export interface ChatProgress {
  type: 'progress';
  of: string;
  phase: ProgressPhase;
}
