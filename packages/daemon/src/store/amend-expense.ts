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
  /** The requirement that asks it: R-7 AC4 under a reply, DK-17 AC6 from a row of "Gastos". */
  rule?: string;
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
        { rule: ask.rule ?? 'R-7 AC4', source: ask.source },
        ask.now,
      ),
      question: ask.question,
      options: ask.options,
      now: ask.now,
    }),
  )();

const amendPayload = z.object({ expense_id: z.int().positive() });

/**
 * R-7 AC9: what "Deshacer" under a correction puts back, kept in its `amend_expense` proposal's
 * `payload_json` beside `expense_id`: the expense's columns the correction changed, as they were
 * before it; the declarations it wrote; and the assertions it refuted, with the status each had.
 * `mode` is kept only when the correction changed it (`corroborated` to `confirmed`, B63); a
 * payload stored before that has none, and its "Deshacer" leaves the mode as it is.
 */
const RESTORED_COLUMNS = [
  'total_cents',
  'merchant_id',
  'category_id',
  'category_basis',
  'occurred_on',
  'mode',
] as const;

export interface CorrectionRestore {
  columns: {
    total_cents?: number | undefined;
    merchant_id?: number | null | undefined;
    category_id?: number | null | undefined;
    category_basis?: string | null | undefined;
    occurred_on?: string | undefined;
    mode?: 'corroborated' | undefined;
  };
  declarations: number[];
  refuted: { id: number; status: 'current' | 'confirmed' }[];
}

const restorePayload = z.object({
  restore: z.object({
    columns: z
      .object({
        total_cents: z.int().optional(),
        merchant_id: z.int().nullable().optional(),
        category_id: z.int().nullable().optional(),
        category_basis: z.string().nullable().optional(),
        occurred_on: z.string().optional(),
        mode: z.literal('corroborated').optional(),
      })
      .strict(),
    declarations: z.array(z.int().positive()),
    refuted: z.array(
      z.object({ id: z.int().positive(), status: z.enum(['current', 'confirmed']) }),
    ),
  }),
});

/**
 * R-7 AC9: what the decision's "Deshacer" puts back; `null` for the question under S-1, S-2;
 * `'unreadable'` for a correction's question whose stored values do not parse, which must
 * never fall back to taking the expense out.
 */
export const restoreOf = (decision: OpenDecision): CorrectionRestore | 'unreadable' | null => {
  const payload: unknown = decision.payload;
  // Mirrors `json_extract(payload_json, '$.restore') IS NULL` in openAmendDecisionOf.
  const carriesRestore =
    typeof payload === 'object' &&
    payload !== null &&
    'restore' in payload &&
    (payload as { restore: unknown }).restore !== null;
  if (!carriesRestore) return null;
  const parsed = restorePayload.safeParse(payload);
  return parsed.success ? parsed.data.restore : 'unreadable';
};

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
 * DK-17 AC6: the latest open or awaiting `amend_expense` question about the expense, the one its
 * reply in the chat shows; `null` when none is. The "Deshacer" under a correction (R-7 AC9) is not
 * one: it puts values back, while a row's "Deshacer" takes the expense out.
 */
export const openAmendDecisionOf = (db: Database.Database, expenseId: number): number | null => {
  const row = db
    .prepare<[number], { id: number }>(
      `SELECT d.id FROM pending_decisions d JOIN proposals p ON p.id = d.proposal_id
       WHERE p.operation = 'amend_expense' AND json_extract(p.payload_json, '$.expense_id') = ?
         AND json_extract(p.payload_json, '$.restore') IS NULL
         AND d.status IN ('open', 'awaiting_text')
       ORDER BY d.id DESC LIMIT 1`,
    )
    .get(expenseId);
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
): { actionId: number; declarations: number[]; restore: CorrectionRestore } => {
  const { expenseId, proposalId, correction, source, receivedAt, now } = amendment;
  const current = db
    .prepare<[number], Required<Omit<CorrectionRestore['columns'], 'mode'>> & { mode: string }>(
      `SELECT total_cents, merchant_id, category_id, category_basis, occurred_on, mode
       FROM expenses WHERE id = ? AND status = 'current'`,
    )
    .get(expenseId);
  if (current === undefined) throw new Error(`expense ${expenseId} is not current`);
  const standing = db.prepare<[number], { id: number; status: 'current' | 'confirmed' }>(
    `SELECT id, status FROM assertions
     WHERE subject_type = 'expense' AND subject_id = ? AND status IN ('current', 'confirmed')`,
  );
  const before = standing.all(expenseId);
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
  // DK-17 AC6: a registered receipt's "Apuntar" confirmed each inference (R-6 AC4); a confirmation
  // of an inference the correction refuted is refuted with it, so only the new word stands.
  db.prepare(
    `UPDATE assertions SET status = 'refuted'
     WHERE subject_type = 'expense' AND subject_id = ? AND mode = 'confirmed' AND status = 'current'
       AND confirms_id IN (SELECT id FROM assertions WHERE status = 'refuted')`,
  ).run(expenseId);
  // R-7 AC9: what "Deshacer" under this correction puts back: only what the correction changed.
  const still = new Set(standing.all(expenseId).map(({ id }) => id));
  const columns: CorrectionRestore['columns'] = {};
  if (correction.total_cents !== undefined) columns.total_cents = current.total_cents;
  if (correction.merchant !== undefined) columns.merchant_id = current.merchant_id;
  if (correction.category !== undefined) {
    columns.category_id = current.category_id;
    columns.category_basis = current.category_basis;
  }
  if (correction.occurred_on !== undefined) columns.occurred_on = current.occurred_on;
  // B63, PRD §7.2: `corroborated` says none of the expense came from the principal; after their
  // correction it is `confirmed`, as a pending receipt they correct is (R-7 AC2). `declared` and
  // `confirmed` already rest on the principal's word and stay.
  if (current.mode === 'corroborated' && declarations.length > 0) {
    db.prepare("UPDATE expenses SET mode = 'confirmed' WHERE id = ?").run(expenseId);
    columns.mode = 'corroborated';
  }
  return {
    actionId,
    declarations,
    restore: {
      columns,
      declarations,
      refuted: before.filter(({ id }) => !still.has(id)),
    },
  };
};

export interface CorrectionUndoQuestion {
  expenseId: number;
  restore: CorrectionRestore;
  /** The principal's correction message. */
  source: string;
  /** The reply it sits under (S-8 or S-102). */
  question: string;
  options: readonly string[];
  now: string;
}

/**
 * R-7 AC9: the "Deshacer" of a correction's reply, an `amend_expense` proposal, `asked`, whose
 * payload keeps what it puts back, and its pending decision. Nothing changes until the principal
 * answers. Returns the decision.
 */
export const openCorrectionUndoDecision = (
  db: Database.Database,
  ask: CorrectionUndoQuestion,
): number =>
  db.transaction(() => {
    const proposalId = Number(
      db
        .prepare(
          `INSERT INTO proposals (matter_id, operation, payload_json, basis_json, status, created_at)
           VALUES (?, 'amend_expense', ?, ?, 'asked', ?)`,
        )
        .run(
          expensesMatterId(db),
          JSON.stringify({ expense_id: ask.expenseId, restore: ask.restore }),
          JSON.stringify({ rule: 'R-7 AC9', source: ask.source }),
          ask.now,
        ).lastInsertRowid,
    );
    return openPendingDecision(db, {
      proposalId,
      question: ask.question,
      options: ask.options,
      now: ask.now,
    });
  })();

/** R-7 AC9: whether every declaration the correction wrote still stands, so it can be undone. */
export const correctionStands = (db: Database.Database, restore: CorrectionRestore): boolean =>
  restore.declarations.every(
    (id) =>
      db
        .prepare<[number], { id: number }>(
          "SELECT id FROM assertions WHERE id = ? AND status = 'current'",
        )
        .get(id) !== undefined,
  );

export interface CorrectionUndo {
  expenseId: number;
  /** The asked `amend_expense` proposal under the correction's reply. */
  proposalId: number;
  restore: CorrectionRestore;
  now: string;
}

/**
 * R-7 AC9: "Deshacer" under a correction puts the expense back as it was right before it: the
 * columns it changed take their old values, its declarations are `refuted`, and the assertions it
 * refuted take back the status they had (R-7 AC3: only `status` changes; nothing is deleted). The
 * expense stays current. The proposal is executed by an action the principal authorized. Throws if
 * the expense is not current or the correction no longer stands, so the caller's work rolls back.
 */
export const undoCorrection = (db: Database.Database, undo: CorrectionUndo): number => {
  const { expenseId, proposalId, restore, now } = undo;
  const current = db
    .prepare<[number], { id: number }>(
      "SELECT id FROM expenses WHERE id = ? AND status = 'current'",
    )
    .get(expenseId);
  if (current === undefined) throw new Error(`expense ${expenseId} is not current`);
  if (!correctionStands(db, restore)) {
    throw new Error(`the correction of expense ${expenseId} no longer stands`);
  }
  settleProposal(db, proposalId, 'executed');
  const actionId = insertAction(db, proposalId, 'principal', now);
  const refute = db.prepare("UPDATE assertions SET status = 'refuted' WHERE id = ?");
  for (const id of restore.declarations) refute.run(id);
  const reinstate = db.prepare(
    "UPDATE assertions SET status = ? WHERE id = ? AND status = 'refuted'",
  );
  for (const { id, status } of restore.refuted) reinstate.run(status, id);
  for (const column of RESTORED_COLUMNS) {
    const value = restore.columns[column];
    if (value === undefined) continue;
    // `column` is one of the fixed names above, never text from the payload.
    db.prepare(`UPDATE expenses SET ${column} = ? WHERE id = ?`).run(value, expenseId);
  }
  return actionId;
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
