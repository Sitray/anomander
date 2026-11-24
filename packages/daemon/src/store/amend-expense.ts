import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { OpenDecision } from '../decisions/types.ts';
import { correctExpense, type ExpenseCorrection, settleProposal } from './decisions.ts';
import { expensesMatterId, insertAction } from './expenses.ts';
import { openPendingDecision } from './receipts.ts';

// Rows of PRD §13 for undoing and correcting a registered expense (R-7 AC4 to AC8): an
// `amend_expense` proposal in the "Keep my expenses" matter, `asked` under the reply of a typed
// expense, or `executed` at once when the principal corrects one by text.

const insertAmendProposal = (
  db: Database.Database,
  expenseId: number,
  status: 'asked' | 'executed',
  basis: Record<string, unknown>,
  now: string,
): number =>
  Number(
    db
      .prepare(
        `INSERT INTO proposals (matter_id, operation, payload_json, basis_json, status, created_at)
         VALUES (?, 'amend_expense', ?, ?, ?, ?)`,
      )
      .run(
        expensesMatterId(db),
        JSON.stringify({ expense_id: expenseId }),
        JSON.stringify(basis),
        status,
        now,
      ).lastInsertRowid,
  );

export interface AmendExpenseQuestion {
  expenseId: number;
  /** The principal's message that registered the expense. */
  source: string;
  /** The reply it sits under (S-1 or S-2). */
  question: string;
  options: readonly string[];
  now: string;
}

/**
 * R-7 AC4: the "Deshacer" and "Corregir" of a typed expense's reply, an `amend_expense` proposal,
 * `asked`, and its pending decision. Nothing changes until the principal answers. Returns the
 * decision.
 */
export const openAmendExpenseDecision = (
  db: Database.Database,
  ask: AmendExpenseQuestion,
): number =>
  db.transaction(() =>
    openPendingDecision(db, {
      proposalId: insertAmendProposal(
        db,
        ask.expenseId,
        'asked',
        { rule: 'R-7 AC4', source: ask.source },
        ask.now,
      ),
      question: ask.question,
      options: ask.options,
      now: ask.now,
    }),
  )();

const amendPayload = z.object({ expense_id: z.int().positive() });

/** The expense an `amend_expense` decision is about. */
export const amendedExpenseOf = (decision: OpenDecision): number =>
  amendPayload.parse(decision.payload).expense_id;

/** R-7 AC8: the expense an `amend_expense` decision is about, or `null` when it is no longer current. */
export const currentExpenseOf = (db: Database.Database, decision: OpenDecision): number | null => {
  const row = db
    .prepare<[number], { id: number }>(
      "SELECT id FROM expenses WHERE id = ? AND status = 'current'",
    )
    .get(amendedExpenseOf(decision));
  return row?.id ?? null;
};

/**
 * R-7 AC8: the open questions about the expense are closed, `expired` with their proposal
 * `rejected` as R-19 AC2 leaves them, so their buttons get S-19. Returns how many.
 */
export const closeAmendDecisions = (db: Database.Database, expenseId: number): number =>
  db.transaction(() => {
    const proposals = db
      .prepare<[number], { id: number }>(
        `SELECT p.id FROM proposals p JOIN pending_decisions d ON d.proposal_id = p.id
         WHERE p.operation = 'amend_expense' AND json_extract(p.payload_json, '$.expense_id') = ?
           AND d.status IN ('open', 'awaiting_text')`,
      )
      .all(expenseId);
    for (const { id } of proposals) {
      db.prepare(
        `UPDATE pending_decisions SET status = 'expired', awaiting_since = NULL
         WHERE proposal_id = ? AND status IN ('open', 'awaiting_text')`,
      ).run(id);
      db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ? AND status = 'asked'").run(
        id,
      );
    }
    return proposals.length;
  })();

/** The asked proposal is executed by the principal's answer, or one is recorded executed. */
const executedBy = (
  db: Database.Database,
  expenseId: number,
  proposalId: number | null,
  source: string,
  now: string,
): number => {
  if (proposalId === null) {
    return insertAmendProposal(db, expenseId, 'executed', { rule: 'R-7 AC7', source }, now);
  }
  settleProposal(db, proposalId, 'executed');
  return proposalId;
};

export interface ExpenseUndo {
  expenseId: number;
  /** The asked `amend_expense` proposal "Deshacer" answers. */
  proposalId: number;
  now: string;
}

/**
 * R-7 AC5: "Deshacer" takes the expense out of the ledger as "Descartar" does (R-6 AC4): it is
 * `refuted`, so no current expense remains, and nothing is deleted. The proposal is executed by
 * an action the principal authorized. Throws if the expense was no longer current, so the
 * caller's work rolls back. Returns the action; the caller then closes the expense's other
 * questions with `closeAmendDecisions`.
 */
export const undoExpense = (db: Database.Database, undo: ExpenseUndo): number => {
  const { expenseId, proposalId, now } = undo;
  settleProposal(db, proposalId, 'executed');
  const actionId = insertAction(db, proposalId, 'principal', now);
  const changed = db
    .prepare("UPDATE expenses SET status = 'refuted' WHERE id = ? AND status = 'current'")
    .run(expenseId).changes;
  if (changed !== 1) throw new Error(`expense ${expenseId} is not current`);
  return actionId;
};

export interface ExpenseAmendment {
  expenseId: number;
  /** The asked proposal "Corregir" answers, or `null` for a correction typed without it (R-7 AC7). */
  proposalId: number | null;
  correction: ExpenseCorrection;
  /** The principal's correction message. */
  source: string;
  receivedAt: string;
  now: string;
}

/**
 * R-7 AC6, AC7: the correction of a current expense, as R-7 AC2 writes it (superseding `declared`
 * assertions, the old ones `refuted`), executed by an action the principal authorized. Throws if
 * the expense was no longer current. Returns the action and the new declarations, in the order of
 * `correctExpense`; the caller then closes the expense's other questions (AC8).
 */
export const amendExpense = (
  db: Database.Database,
  amendment: ExpenseAmendment,
): { actionId: number; declarations: number[] } => {
  const { expenseId, proposalId, correction, source, receivedAt, now } = amendment;
  const current = db
    .prepare<[number], { id: number }>(
      "SELECT id FROM expenses WHERE id = ? AND status = 'current'",
    )
    .get(expenseId);
  if (current === undefined) throw new Error(`expense ${expenseId} is not current`);
  const proposal = executedBy(db, expenseId, proposalId, source, now);
  const actionId = insertAction(db, proposal, 'principal', now);
  const declarations = correctExpense(db, {
    expenseId,
    correction,
    source,
    receivedAt,
    now,
    registered: true,
  });
  return { actionId, declarations };
};

export interface RecentExpense {
  id: number;
  total_cents: number;
  merchant: string | null;
  category: string | null;
  occurred_on: string;
}

/** The most recent expenses a typed correction may point at (R-7 AC7). */
export const RECENT_EXPENSE_LIMIT = 5;

/**
 * R-7 AC7: the current expenses registered since `since`, newest first, at most
 * `RECENT_EXPENSE_LIMIT`: what the text interpreter may point a correction at.
 */
export const recentExpenses = (db: Database.Database, since: string): RecentExpense[] =>
  db
    .prepare<[string, number], RecentExpense>(
      `SELECT e.id, e.total_cents, m.name AS merchant, c.name AS category, e.occurred_on
       FROM expenses e
       LEFT JOIN actions a    ON a.id = e.created_by_action_id
       LEFT JOIN entities m   ON m.id = e.merchant_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.status = 'current' AND coalesce(a.executed_at, e.created_at) >= ?
       ORDER BY coalesce(a.executed_at, e.created_at) DESC, e.id DESC
       LIMIT ?`,
    )
    .all(since, RECENT_EXPENSE_LIMIT);
