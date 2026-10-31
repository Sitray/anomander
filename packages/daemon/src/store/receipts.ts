import {
  type AssertionDraft,
  type AssertionRef,
  type AuthorityPermission,
  type CategoryBasis,
  type ConsistencyResult,
  corroborate,
  type ExistingExpense,
  type ProcessorInference,
} from '@anomander/core';
import type Database from 'better-sqlite3';
import {
  categoryIdOf,
  findOrCreateMerchant,
  insertAction,
  insertAssertion,
  insertProposal,
} from './expenses.ts';

// Rows of PRD §13 for the receipt cycle (§10). Only core-validated shapes are written.

export interface ReceivedReceipt {
  /** `telegram:<message_id>` or `telegram:album:<media_group_id>`. */
  source: string;
  receivedAt: string;
  mimeTypes: readonly string[];
  now: string;
}

/**
 * §10 step 1 and R-3 AC1: the `documents` row, `queued` while its images are on disk, and the
 * observation that the images were received. Returns the document id.
 */
export const createReceiptDocument = (db: Database.Database, receipt: ReceivedReceipt): number =>
  db.transaction(() => {
    const document = db
      .prepare(
        `INSERT INTO documents (kind, received_at, source, image_count, status)
         VALUES ('receipt', ?, ?, ?, 'queued')`,
      )
      .run(receipt.receivedAt, receipt.source, receipt.mimeTypes.length);
    const documentId = Number(document.lastInsertRowid);
    insertAssertion(
      db,
      {
        subject_type: 'document',
        subject_id: documentId,
        predicate: 'images_received',
        value_json: { image_count: receipt.mimeTypes.length, mime_types: [...receipt.mimeTypes] },
        mode: 'observed',
        actor: 'source',
        source: receipt.source,
        basis_json: null,
        confidence: null,
        valid_at: receipt.receivedAt,
        expires_at: null,
        status: 'current',
        supersedes_id: null,
        confirms_id: null,
      },
      receipt.now,
    );
    return documentId;
  })();

/** R-8 AC1: reading finished and the images were deleted; the document leaves `queued`. */
export const finishReading = (
  db: Database.Database,
  documentId: number,
  status: 'read' | 'unreadable',
  imageDeletedAt: string,
): void => {
  db.prepare(
    "UPDATE documents SET status = ?, image_deleted_at = ? WHERE id = ? AND status = 'queued'",
  ).run(status, imageDeletedAt, documentId);
};

/** R-4 AC3: the current expenses a receipt may duplicate. */
export const listCurrentExpenses = (db: Database.Database): ExistingExpense[] =>
  db
    .prepare<[], ExistingExpense>(
      `SELECT coalesce(m.name, '') AS merchant, e.occurred_on, e.total_cents, e.status
       FROM expenses e LEFT JOIN entities m ON m.id = e.merchant_id
       WHERE e.status = 'current'`,
    )
    .all();

const parseConditions = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    // Conditions code cannot read cover nothing.
    return null;
  }
};

/** §8.1: the permissions that are neither revoked nor expired at `now` (ISO 8601, `Z`). */
export const listActivePermissions = (db: Database.Database, now: Date): AuthorityPermission[] =>
  db
    .prepare<
      [string],
      {
        id: number;
        operation: string;
        conditions_json: string;
        expires_at: string | null;
        revoked_at: string | null;
      }
    >(
      `SELECT id, operation, conditions_json, expires_at, revoked_at FROM permissions
       WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id`,
    )
    .all(now.toISOString())
    .map(({ conditions_json, ...permission }) => ({
      ...permission,
      conditions: parseConditions(conditions_json),
    }));

export interface ReceiptLineRow {
  name: string;
  quantity: number;
  amount_cents: number;
  inference: ProcessorInference;
}

export interface ReceiptExpenseRegistration {
  documentId: number;
  /** The principal's message: the source of the caption's declarations. */
  channelRef: string;
  receivedAt: string;
  processorSource: string;
  now: string;
  merchant: string;
  occurred_on: string;
  total_cents: number;
  category: string | null;
  category_basis: CategoryBasis | null;
  /** Extracted inferences about the expense it rests on: merchant (unless declared), date, total. */
  extracted: readonly ProcessorInference[];
  lines: readonly ReceiptLineRow[];
  /** The inferred category, when it is the category basis. */
  categoryInference: ProcessorInference | null;
  /** What the caption declared and the expense uses (R-3 AC5). */
  declared: { merchant: string | null; category: string | null };
  consistency: ConsistencyResult;
  /** `permission:<id>` when a permission covers it (R-6 AC1); `null` asks the principal. */
  authorizedBy: string | null;
}

/**
 * §10 steps 5 to 7 in one transaction: proposal, action (when authorized), expense, purchase
 * lines, inferences, the caption's declarations and, when R-4 passed, the code confirmations.
 */
export const insertReceiptExpense = (
  db: Database.Database,
  registration: ReceiptExpenseRegistration,
): { expenseId: number; proposalId: number; actionId: number | null } =>
  db.transaction(() => {
    const { now, consistency, authorizedBy } = registration;
    const proposalId = insertProposal(db, {
      payload: {
        document_id: registration.documentId,
        total_cents: registration.total_cents,
        merchant: registration.merchant,
        occurred_on: registration.occurred_on,
        category: registration.category,
        category_basis: registration.category_basis,
        lines: registration.lines.map(({ name, quantity, amount_cents }) => ({
          name,
          quantity,
          amount_cents,
        })),
      },
      basis: { source: registration.channelRef, checks: consistency.checks },
      status: authorizedBy === null ? 'asked' : 'executed',
      now,
    });
    const actionId = authorizedBy === null ? null : insertAction(db, proposalId, authorizedBy, now);
    const expense = db
      .prepare(
        `INSERT INTO expenses (merchant_id, occurred_on, total_cents, category_id, category_basis,
           mode, document_id, status, created_by_action_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        findOrCreateMerchant(db, registration.merchant, now),
        registration.occurred_on,
        registration.total_cents,
        categoryIdOf(db, registration.category),
        registration.category_basis,
        consistency.passed ? 'corroborated' : 'inferred',
        registration.documentId,
        authorizedBy === null ? 'pending' : 'current',
        actionId,
        now,
      );
    const expenseId = Number(expense.lastInsertRowid);

    const store = (inference: ProcessorInference, subjectType: string, subjectId: number) => {
      const draft: AssertionDraft = {
        ...inference,
        subject_type: subjectType,
        subject_id: subjectId,
        actor: 'processor',
        source: registration.processorSource,
        valid_at: registration.receivedAt,
        expires_at: null,
        status: 'current',
        supersedes_id: null,
        confirms_id: null,
      };
      const ref: AssertionRef = { ...draft, id: insertAssertion(db, draft, now) };
      return ref;
    };

    const extracted = registration.extracted.map((inference) =>
      store(inference, 'expense', expenseId),
    );
    const insertLine = db.prepare(
      `INSERT INTO purchase_lines (expense_id, product_name, quantity, amount_cents)
       VALUES (?, ?, ?, ?)`,
    );
    for (const line of registration.lines) {
      const lineId = Number(
        insertLine.run(expenseId, line.name, line.quantity, line.amount_cents).lastInsertRowid,
      );
      extracted.push(store(line.inference, 'purchase_line', lineId));
    }
    if (registration.categoryInference !== null) {
      store(registration.categoryInference, 'expense', expenseId);
    }

    // R-4 AC4: one code confirmation per extracted inference, which becomes `confirmed`.
    const corroboration = corroborate(consistency, extracted, now);
    for (const confirmation of corroboration?.confirmations ?? []) {
      insertAssertion(db, confirmation, now);
    }
    const confirm = db.prepare("UPDATE assertions SET status = 'confirmed' WHERE id = ?");
    for (const id of corroboration?.confirmedIds ?? []) confirm.run(id);

    // R-3 AC5: what the caption stated is the principal's declaration.
    for (const [predicate, value] of Object.entries(registration.declared)) {
      if (value === null) continue;
      insertAssertion(
        db,
        {
          subject_type: 'expense',
          subject_id: expenseId,
          predicate,
          value_json: value,
          mode: 'declared',
          actor: 'principal',
          source: registration.channelRef,
          basis_json: null,
          confidence: null,
          valid_at: registration.receivedAt,
          expires_at: null,
          status: 'current',
          supersedes_id: null,
          confirms_id: null,
        },
        now,
      );
    }
    return { expenseId, proposalId, actionId };
  })();

export interface DecisionRow {
  proposalId: number;
  /** The §12 text that asks it (S-3, S-4 or S-6). */
  question: string;
  options: readonly string[];
  now: string;
}

/** R-6 AC2: a question only the principal can answer, `open` until answered. */
export const openPendingDecision = (db: Database.Database, decision: DecisionRow): number =>
  Number(
    db
      .prepare(
        `INSERT INTO pending_decisions (proposal_id, question, options_json, status, created_at)
         VALUES (?, ?, ?, 'open', ?)`,
      )
      .run(decision.proposalId, decision.question, JSON.stringify(decision.options), decision.now)
      .lastInsertRowid,
  );

/** R-17 AC2: the message that shows the decision, so a reply to it can find it. */
export const recordDecisionMessage = (
  db: Database.Database,
  decisionId: number,
  channelRef: string,
): boolean =>
  db
    .prepare('UPDATE pending_decisions SET channel_ref = ? WHERE id = ? AND channel_ref IS NULL')
    .run(channelRef, decisionId).changes === 1;
