import type { Reply } from '@anomander/protocol';
import type Database from 'better-sqlite3';

// The answer to a pending decision (R-17 AC1) is dispatched by the operation of its proposal:
// `register_expense` (R-6 AC4, R-7) or `keep_receipt` (R-8 AC3, AC4). Each operation owns one
// handler; `src/decisions/answer.ts` holds the dispatch table.

export interface OpenDecision {
  id: number;
  proposal_id: number;
  /** The proposal's `operation`. */
  operation: string;
  /** The proposal's parsed `payload_json`. */
  payload: unknown;
  /** The option labels, as stored in `options_json`. */
  options: string[];
  status: 'open' | 'awaiting_text';
  channel_ref: string | null;
}

export interface DecisionAnswer {
  db: Database.Database;
  decision: OpenDecision;
  /** The label of the pressed option, e.g. `Apuntar` or `Sí`. */
  option: string;
  now: () => Date;
}

/** Records the answer and returns what to tell the principal. */
export type DecisionAnswerHandler = (answer: DecisionAnswer) => Promise<Reply>;
