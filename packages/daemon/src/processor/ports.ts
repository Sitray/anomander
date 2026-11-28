import type { ProcessorInference } from '@anomander/core';
import type { ComputerAction, Money, RouteKind } from '@anomander/protocol';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type { CapabilityCall } from '../capabilities/capability.ts';
import type { RecentTurn } from '../conversation/recent-turns.ts';
import type { RecentExpense } from '../store/amend-expense.ts';
import type { HistoryEntry } from '../store/history.ts';
import type { Memory, MemoryNote } from '../store/memory.ts';

// The processor's ports: what the daemon asks of a model, and what it hands each reader and
// interpreter. The pi-ai adapters next to this file implement them; tests pass their own. Each
// adapter re-exports the types of its port, so either path can be imported.

export type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

/** `models.complete` of pi-ai, or a recorded response in tests. */
/** `signal` aborts the call when its timeout passes (R-22 AC2). */
export type Complete<M> = (
  model: M,
  context: Context,
  signal?: AbortSignal,
) => Promise<AssistantMessage>;

// The text interpreter (`text-interpreter.ts`).

export interface TextInterpreterInput {
  text: string;
  /** Today as `YYYY-MM-DD` in `TZ`, so the processor can resolve "ayer" (R-2 AC7). */
  today: string;
  /** The existing categories; the processor may only pick one of them (R-5 AC2). */
  categories: string[];
  /** The recent turns, oldest first (R-16 AC3). */
  recent: RecentTurn[];
  /** The current memories, for conversation replies only (R-23 AC4). */
  memories: Memory[];
  /** What each capability adds to the user turn, under its name (R-24 AC1, R-25 AC1). */
  capabilities?: Record<string, unknown>;
  /** The ways this front door can carry out a request (DK-13 AC1); none when absent. */
  routes?: readonly RouteKind[];
  /** What ANOMANDER did lately, oldest first (DK-14 AC3); none when absent. */
  history?: readonly HistoryEntry[];
  /** The tools of the servers the principal connected (DK-11, T17); none when absent. */
  connected?: readonly ConnectedTool[];
  /** The recent current expenses a correction may point at (R-7 AC7); none when absent. */
  expenses?: readonly RecentExpense[];
}

/**
 * A tool of a connected server, so the processor can tell what a task with connections can do
 * (T17). `purpose` is the server's own description, empty when it is not known yet.
 */
export interface ConnectedTool {
  server: string;
  tool: string;
  purpose: string;
}

/** A lasting fact about the principal the processor found in the message (R-23 AC1). */
export interface MemoryFact {
  text: string;
  /** The words of the message it rests on. */
  quote: string;
  /** Whether the principal said it; code still checks the quote before calling it declared. */
  said: boolean;
  confidence: number;
  /** The id of the current memory it replaces (R-23 AC3). */
  replaces: number | null;
}

export type Interpretation =
  | { kind: 'expense'; inferences: ProcessorInference[]; memories: MemoryFact[] }
  | { kind: 'conversation'; reply: string; memories: MemoryFact[] }
  /** The principal asks what ANOMANDER remembers; code lists it (R-23 AC5). */
  | { kind: 'memory_list' }
  /**
   * The principal asks to forget something: the ids of the matching memories among the ones the
   * processor was given, possibly none. Code asks before erasing anything (R-23 AC6).
   */
  | { kind: 'forget'; ids: number[] }
  /** The principal asks to erase what ANOMANDER did; code asks before erasing (DK-14 AC4). */
  | { kind: 'forget_history' }
  /**
   * The principal asks to create a category (R-18 AC1): the name as written, and S-36 worded by
   * the processor, sent only if the category already exists and the wording keeps the facts
   * (R-21). Code proposes the category; the processor never creates one (R-5 AC3).
   */
  | { kind: 'category'; name: string; reply: string | null }
  /**
   * The principal states a rule, "Mercadona es supermercado" (R-13 AC1): the merchant and the
   * category as written, and a conversational reply sent only when that rule is already active.
   * Code asks S-11 before storing anything; the processor never stores a policy (§13).
   */
  | { kind: 'policy'; merchant: string; category: string; reply: string | null }
  /** A capability call, validated against its capability's schema (R-24 AC2). */
  | { kind: 'capability'; call: CapabilityCall }
  /** DK-13 AC1: the request goes one of the ways the door offers; code starts it. */
  | { kind: 'route'; to: RouteKind; task: string }
  /** DK-13 AC1: the request needs a way this door does not offer; nothing is started. */
  | { kind: 'route_elsewhere'; to: RouteKind }
  /** T17: a lookup on the internet, and no connection can search; nothing is started. */
  | { kind: 'no_web_search' }
  /**
   * R-7 AC7: the principal corrects a recent expense by text ("no eran 23, eran 32"): the id of
   * the expense among the ones the processor was given, or `null` when it is not clear which, and
   * the new values, each quoting the message. Code checks both before writing anything.
   */
  | { kind: 'expense_correct'; expenseId: number | null; inferences: ProcessorInference[] }
  | { kind: 'invalid'; reason: string }
  /** The processor failed or did not answer in time: nothing to interpret (R-22 AC1). */
  | { kind: 'failed'; reason: string }
  /** The daily AI budget is spent, so the processor was not called (R-12 AC4). */
  | { kind: 'budget_exhausted' };

/** The processor port. */
export type TextInterpreter = (input: TextInterpreterInput) => Promise<Interpretation>;

// The correction interpreter (`correction-interpreter.ts`).

export interface CorrectionInterpreterInput {
  text: string;
  /** The expense being corrected, as stored. */
  expense: {
    /** In the expense's own currency, which may not be the principal's now (DK-25, B87). */
    total: Money;
    merchant: string | null;
    category: string | null;
    occurred_on: string;
  };
  categories: string[];
  /** Today in `TZ`, so a named date ("el 28", "ayer") can be resolved. */
  today: string;
}

export type CorrectionInterpretation =
  | { kind: 'correction'; inferences: ProcessorInference[] }
  | { kind: 'invalid'; reason: string }
  /** The processor failed or did not answer in time (R-22 AC1). */
  | { kind: 'failed'; reason: string }
  /** The daily AI budget is spent, so the processor was not called (R-12 AC4). */
  | { kind: 'budget_exhausted' };

export type CorrectionInterpreter = (
  input: CorrectionInterpreterInput,
) => Promise<CorrectionInterpretation>;

// The receipt reader (`receipt-reader.ts`).

export interface ReceiptReaderImage {
  mimeType: string;
  data: Uint8Array;
}

export interface ReceiptReaderInput {
  /** Every image of the receipt, read together in one call (R-3 AC4). */
  images: readonly ReceiptReaderImage[];
  /** The principal's caption, a declaration sent with the images (R-3 AC5). */
  caption: string | null;
  /** Today as `YYYY-MM-DD` in `TZ`. */
  today: string;
  /** The existing categories; the processor may only pick one of them (R-5 AC2). */
  categories: string[];
}

export interface ReceiptLine {
  name: string;
  quantity: number;
  amount_cents: number;
}

/** A validated inference and its typed value. */
export interface Inferred<T> {
  inference: ProcessorInference;
  value: T;
}

export interface ReceiptRead {
  kind: 'read';
  merchant: Inferred<string>;
  occurredOn: Inferred<string>;
  total: Inferred<number>;
  lines: Inferred<ReceiptLine>[];
  category: Inferred<string> | null;
  /** Read from the caption, not from the receipt (R-3 AC5). */
  declaredCategory: Inferred<string> | null;
  declaredMerchant: Inferred<string> | null;
}

export type ReceiptReading = ReceiptRead | { kind: 'unreadable'; reason: string };

/** The vision processor port. */
export type ReceiptReader = (input: ReceiptReaderInput) => Promise<ReceiptReading>;

// The reply phraser (`reply-phraser.ts`).

export interface PhraseRequest {
  /** The §12 string: what the processor rewords, and the fallback (R-21 AC1, AC2). */
  reference: string;
  /** Facts read from the database, formatted as in §12, that the reply must contain. */
  facts: string[];
  /** The principal's message, so the reply can match its tone. */
  message: string;
}

/** Always resolves to a text that can be sent: the phrased one or the reference. */
export type ReplyPhraser = (request: PhraseRequest) => Promise<string>;

// The screen reader (`screen-reader.ts`).

export interface ScreenReaderInput {
  /** What the principal asks. */
  question: string;
  image: { mimeType: string; data: Uint8Array };
  /** What the principal said about themselves (DK-14 AC1), `declared` only; none when absent. */
  memories?: readonly MemoryNote[];
}

export type ScreenReading =
  | { kind: 'answer'; text: string }
  | { kind: 'failed' }
  | { kind: 'budget_exhausted' }
  /** The provider's own quota or rate limit is spent. */
  | { kind: 'provider_limit' };

/** The vision processor port for the screen. */
export type ScreenReader = (input: ScreenReaderInput) => Promise<ScreenReading>;

// The computer planner (`computer-planner.ts`).

export interface ComputerPlannerInput {
  task: string;
  image: { mimeType: string; data: Uint8Array };
  /** The steps already performed, as they were described, oldest first. */
  done: readonly string[];
  /** What the principal said about themselves (DK-14 AC1), `declared` only; none when absent. */
  memories?: readonly MemoryNote[];
}

export type ComputerPlan =
  /**
   * One action to propose, what it is in the principal's language, and whether they must allow
   * it first.
   */
  | { kind: 'action'; action: ComputerAction; text: string; confirm: boolean }
  /** The task is over: the processor's own words, and whether it says the task was done. */
  | { kind: 'end'; text: string; completed: boolean }
  | { kind: 'failed' }
  | { kind: 'budget_exhausted' }
  /** The provider's own quota or rate limit is spent. */
  | { kind: 'provider_limit' };

export type ComputerPlanner = (input: ComputerPlannerInput) => Promise<ComputerPlan>;
