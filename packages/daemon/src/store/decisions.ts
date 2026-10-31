import type { DecisionStatus } from '@anomander/core';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { OpenDecision } from '../decisions/types.ts';
import { categoryIdOf, findOrCreateMerchant, insertAction, insertAssertion } from './expenses.ts';

// Rows of PRD §13 for answering pending decisions (R-6 AC4, R-7, R-17).

/** R-17 AC6: a decision `awaiting_text` this long without text returns to `open`. */
export const AWAITING_TEXT_TIMEOUT_MS = 15 * 60 * 1000;

export interface StoredDecision extends Omit<OpenDecision, 'status'> {
  status: DecisionStatus;
  awaiting_since: string | null;
}

interface DecisionRow {
  id: number;
  proposal_id: number;
  operation: string;
  payload_json: string;
  options_json: string;
  status: DecisionStatus;
  channel_ref: string | null;
  awaiting_since: string | null;
}

const SELECT_DECISION = `SELECT d.id, d.proposal_id, p.operation, p.payload_json, d.options_json,
    d.status, d.channel_ref, d.awaiting_since
  FROM pending_decisions d JOIN proposals p ON p.id = d.proposal_id`;

const toDecision = ({ payload_json, options_json, ...row }: DecisionRow): StoredDecision => ({
  ...row,
  payload: JSON.parse(payload_json),
  options: JSON.parse(options_json),
});

const toOpen = (decision: StoredDecision | null): OpenDecision | null =>
  decision !== null && (decision.status === 'open' || decision.status === 'awaiting_text')
    ? { ...decision, status: decision.status }
    : null;

/** A decision in any status, or `null` when there is none with that id. */
export const loadDecision = (db: Database.Database, id: number): StoredDecision | null => {
  const row = db.prepare<[number], DecisionRow>(`${SELECT_DECISION} WHERE d.id = ?`).get(id);
  return row === undefined ? null : toDecision(row);
};

/** R-17 AC1: only `open` and `awaiting_text` decisions take an answer. */
export const asOpenDecision = toOpen;

/** R-17 AC2: the open or awaiting decision shown in that message. */
export const findDecisionShownIn = (
  db: Database.Database,
  channelRef: string,
): OpenDecision | null => {
  const row = db
    .prepare<[string], DecisionRow>(
      `${SELECT_DECISION} WHERE d.channel_ref = ? AND d.status IN ('open', 'awaiting_text')`,
    )
    .get(channelRef);
  return row === undefined ? null : toOpen(toDecision(row));
};

/** R-17 AC3: the one decision waiting for text, if any (index `one_awaiting_text`). */
export const findAwaitingDecision = (db: Database.Database): OpenDecision | null => {
  const row = db
    .prepare<[], DecisionRow>(`${SELECT_DECISION} WHERE d.status = 'awaiting_text'`)
    .get();
  return row === undefined ? null : toOpen(toDecision(row));
};

/** R-17 AC6: a decision awaiting text for 15 minutes returns to `open`. Returns how many did. */
export const reopenStaleAwaiting = (db: Database.Database, now: Date): number =>
  db
    .prepare(
      `UPDATE pending_decisions SET status = 'open', awaiting_since = NULL
       WHERE status = 'awaiting_text' AND awaiting_since <= ?`,
    )
    .run(new Date(now.getTime() - AWAITING_TEXT_TIMEOUT_MS).toISOString()).changes;

/**
 * R-7 AC1, R-17 AC3: the decision waits for the principal's text; any other one that was
 * waiting goes back to `open` first, so `one_awaiting_text` holds.
 */
export const awaitText = (db: Database.Database, decisionId: number, now: string): void =>
  db.transaction(() => {
    db.prepare(
      `UPDATE pending_decisions SET status = 'open', awaiting_since = NULL
       WHERE status = 'awaiting_text' AND id <> ?`,
    ).run(decisionId);
    const changed = db
      .prepare(
        `UPDATE pending_decisions SET status = 'awaiting_text', awaiting_since = ?
         WHERE id = ? AND status IN ('open', 'awaiting_text')`,
      )
      .run(now, decisionId).changes;
    if (changed !== 1) throw new Error(`decision ${decisionId} is not open`);
  })();

/** The decision is answered; it throws if it was no longer open, so the caller's work rolls back. */
export const answerDecision = (
  db: Database.Database,
  decisionId: number,
  answerAssertionId: number | null,
): void => {
  const changed = db
    .prepare(
      `UPDATE pending_decisions
       SET status = 'answered', awaiting_since = NULL, answer_assertion_id = ?
       WHERE id = ? AND status IN ('open', 'awaiting_text')`,
    )
    .run(answerAssertionId, decisionId).changes;
  if (changed !== 1) throw new Error(`decision ${decisionId} is not open`);
};

const settleProposal = (
  db: Database.Database,
  proposalId: number,
  status: 'executed' | 'rejected',
) => {
  const changed = db
    .prepare("UPDATE proposals SET status = ? WHERE id = ? AND status = 'asked'")
    .run(status, proposalId).changes;
  if (changed !== 1) throw new Error(`proposal ${proposalId} was not asked`);
};

const registerExpensePayload = z.object({ document_id: z.int().positive() });

/** The pending expense a `register_expense` decision asks about (one per receipt document). */
export const pendingExpenseOf = (db: Database.Database, decision: OpenDecision): number => {
  const { document_id } = registerExpensePayload.parse(decision.payload);
  const row = db
    .prepare<[number], { id: number }>(
      "SELECT id FROM expenses WHERE document_id = ? AND status = 'pending'",
    )
    .get(document_id);
  if (row === undefined) throw new Error(`decision ${decision.id} has no pending expense`);
  return row.id;
};

interface StandingInference {
  id: number;
  subject_type: string;
  subject_id: number;
  predicate: string;
  value_json: string;
}

export interface PrincipalRegistration {
  expenseId: number;
  proposalId: number;
  /** Where the principal's answer came from, e.g. the pressed button's data. */
  source: string;
  now: string;
}

/**
 * R-6 AC4 (§7.2, §8.2): the principal authorizes the pending expense. A new action
 * (`authorized_by 'principal'`), one `confirmed` assertion by the principal per inference the
 * expense still rests on (each becomes `confirmed`), the expense `current` with mode
 * `confirmed`, and the proposal `executed`. Returns the action and the confirmation of the
 * total, the answer of "Apuntar".
 */
export const registerByPrincipal = (
  db: Database.Database,
  registration: PrincipalRegistration,
): { actionId: number; totalConfirmationId: number | null } => {
  const { expenseId, proposalId, source, now } = registration;
  settleProposal(db, proposalId, 'executed');
  const actionId = insertAction(db, proposalId, 'principal', now);
  const standing = db
    .prepare<[number, number], StandingInference>(
      `SELECT id, subject_type, subject_id, predicate, value_json FROM assertions
       WHERE mode = 'inferred' AND status IN ('current', 'confirmed')
         AND ((subject_type = 'expense' AND subject_id = ?)
           OR (subject_type = 'purchase_line'
             AND subject_id IN (SELECT id FROM purchase_lines WHERE expense_id = ?)))
       ORDER BY id`,
    )
    .all(expenseId, expenseId);
  const confirm = db.prepare("UPDATE assertions SET status = 'confirmed' WHERE id = ?");
  let totalConfirmationId: number | null = null;
  for (const inference of standing) {
    const id = insertAssertion(
      db,
      {
        subject_type: inference.subject_type,
        subject_id: inference.subject_id,
        predicate: inference.predicate,
        value_json: JSON.parse(inference.value_json),
        mode: 'confirmed',
        actor: 'principal',
        source,
        basis_json: null,
        confidence: null,
        valid_at: now,
        expires_at: null,
        status: 'current',
        supersedes_id: null,
        confirms_id: inference.id,
      },
      now,
    );
    confirm.run(inference.id);
    if (inference.subject_type === 'expense' && inference.predicate === 'total') {
      totalConfirmationId = id;
    }
  }
  db.prepare(
    `UPDATE expenses SET status = 'current', mode = 'confirmed', created_by_action_id = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(actionId, expenseId);
  return { actionId, totalConfirmationId };
};

/** R-6 AC4: "Descartar" rejects the proposal; the pending expense is refuted, never current. */
export const rejectByPrincipal = (
  db: Database.Database,
  expenseId: number,
  proposalId: number,
): void => {
  settleProposal(db, proposalId, 'rejected');
  db.prepare("UPDATE expenses SET status = 'refuted' WHERE id = ? AND status = 'pending'").run(
    expenseId,
  );
};

/** What a correction text changes; each value was written by the principal (R-7 AC2). */
export interface ExpenseCorrection {
  total_cents?: number;
  merchant?: string;
  /** An existing category, lowercase. */
  category?: string;
}

export interface CorrectionRegistration {
  expenseId: number;
  correction: ExpenseCorrection;
  /** The principal's correction message, `telegram:<message_id>`. */
  source: string;
  receivedAt: string;
  now: string;
}

/**
 * R-7 AC2: each corrected value is a `declared` assertion by the principal that supersedes the
 * assertion it corrects, which becomes `refuted`; the expense takes the new value. Returns the
 * ids of the new declarations, in the order total, merchant, category.
 */
export const correctExpense = (
  db: Database.Database,
  registration: CorrectionRegistration,
): number[] => {
  const { expenseId, correction, source, receivedAt, now } = registration;
  const corrected = db.prepare<[number, string], { id: number }>(
    `SELECT id FROM assertions
     WHERE subject_type = 'expense' AND subject_id = ? AND predicate = ?
       AND mode IN ('inferred', 'declared') AND status IN ('current', 'confirmed')
     ORDER BY id DESC LIMIT 1`,
  );
  const refute = db.prepare("UPDATE assertions SET status = 'refuted' WHERE id = ?");
  const declare = (predicate: string, value: string | number): number => {
    const old = corrected.get(expenseId, predicate)?.id ?? null;
    const id = insertAssertion(
      db,
      {
        subject_type: 'expense',
        subject_id: expenseId,
        predicate,
        value_json: value,
        mode: 'declared',
        actor: 'principal',
        source,
        basis_json: null,
        confidence: null,
        valid_at: receivedAt,
        expires_at: null,
        status: 'current',
        supersedes_id: old,
        confirms_id: null,
      },
      now,
    );
    if (old !== null) refute.run(old);
    return id;
  };

  const ids: number[] = [];
  if (correction.total_cents !== undefined) {
    ids.push(declare('total', correction.total_cents));
    db.prepare('UPDATE expenses SET total_cents = ? WHERE id = ?').run(
      correction.total_cents,
      expenseId,
    );
  }
  if (correction.merchant !== undefined) {
    ids.push(declare('merchant', correction.merchant));
    db.prepare('UPDATE expenses SET merchant_id = ? WHERE id = ?').run(
      findOrCreateMerchant(db, correction.merchant, now),
      expenseId,
    );
  }
  if (correction.category !== undefined) {
    ids.push(declare('category', correction.category));
    db.prepare("UPDATE expenses SET category_id = ?, category_basis = 'declared' WHERE id = ?").run(
      categoryIdOf(db, correction.category),
      expenseId,
    );
  }
  return ids;
};
