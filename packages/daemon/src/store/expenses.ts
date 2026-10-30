import {
  type AssertionDraft,
  assertionDraftSchema,
  type CategoryBasis,
  type CategoryPolicy,
  type ProcessorInference,
} from '@anomander/core';
import type { Delivery } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';

// Rows of PRD §13 for the expense cycles. Only core-validated shapes are written.

const EXPENSES_MATTER = 'Keep my expenses';

/** §7.2: every assertion passes `assertionDraftSchema` before it is stored. Returns its id. */
export const insertAssertion = (
  db: Database.Database,
  draft: AssertionDraft,
  createdAt: string = new Date().toISOString(),
): number => {
  const valid = assertionDraftSchema.parse(draft);
  const result = db
    .prepare(
      `INSERT INTO assertions (subject_type, subject_id, predicate, value_json, mode, actor, source,
         basis_json, confidence, valid_at, expires_at, status, supersedes_id, confirms_id, created_at)
       VALUES (@subject_type, @subject_id, @predicate, @value_json, @mode, @actor, @source,
         @basis_json, @confidence, @valid_at, @expires_at, @status, @supersedes_id, @confirms_id,
         @created_at)`,
    )
    .run({
      ...valid,
      value_json: JSON.stringify(valid.value_json),
      basis_json: valid.basis_json === null ? null : JSON.stringify(valid.basis_json),
      created_at: createdAt,
    });
  return Number(result.lastInsertRowid);
};

export const listCategories = (db: Database.Database): string[] =>
  db
    .prepare<[], { name: string }>('SELECT name FROM categories ORDER BY name')
    .all()
    .map((row) => row.name);

const policyRule = z.object({ merchant: z.string(), category: z.string() });

/** R-5 AC1: only active policies take part in categorization. */
export const listActivePolicies = (db: Database.Database): CategoryPolicy[] =>
  db
    .prepare<[], { rule_json: string }>('SELECT rule_json FROM policies WHERE active = 1')
    .all()
    .flatMap((row) => {
      const rule = policyRule.safeParse(JSON.parse(row.rule_json));
      return rule.success ? [rule.data] : [];
    });

export interface TextExpenseRegistration {
  total_cents: number;
  merchant: string | null;
  occurred_on: string;
  category: string | null;
  category_basis: CategoryBasis | null;
  /** From the authority check: `principal` for a text expense (R-2 AC2). */
  authorized_by: string;
  /** The principal's message, the source of the declarations. */
  channelRef: string;
  receivedAt: string;
  /** A category the principal wrote in the message (R-2 AC3), even one that does not exist. */
  declaredCategory: string | null;
  /** Accepted processor inferences (R-14 AC2), stored about the new expense. */
  inferences: readonly ProcessorInference[];
  processorSource: string;
  now: string;
}

/** The merchant entity, found case-insensitively or created. */
export const findOrCreateMerchant = (db: Database.Database, name: string, now: string): number => {
  const wanted = name.toLowerCase();
  const existing = db
    .prepare<[], { id: number; name: string }>(
      "SELECT id, name FROM entities WHERE kind = 'merchant' ORDER BY id",
    )
    .all()
    .find((row) => row.name.toLowerCase() === wanted);
  if (existing) return existing.id;
  const created = db
    .prepare("INSERT INTO entities (kind, name, created_at) VALUES ('merchant', ?, ?)")
    .run(name, now);
  return Number(created.lastInsertRowid);
};

export const idOf = (db: Database.Database, sql: string, ...params: unknown[]): number | null =>
  db.prepare<unknown[], { id: number }>(sql).get(...params)?.id ?? null;

export const categoryIdOf = (db: Database.Database, name: string | null): number | null =>
  name === null ? null : idOf(db, 'SELECT id FROM categories WHERE name = ?', name);

export interface ProposalRow {
  payload: Record<string, unknown>;
  basis: Record<string, unknown>;
  status: 'executed' | 'asked';
  now: string;
}

/** A `register_expense` proposal in the "Keep my expenses" matter (§8.2). Returns its id. */
export const insertProposal = (db: Database.Database, proposal: ProposalRow): number => {
  const matterId = idOf(
    db,
    "SELECT id FROM matters WHERE title = ? AND status IN ('open', 'active', 'waiting')",
    EXPENSES_MATTER,
  );
  const result = db
    .prepare(
      `INSERT INTO proposals (matter_id, operation, payload_json, basis_json, status, created_at)
       VALUES (?, 'register_expense', ?, ?, ?, ?)`,
    )
    .run(
      matterId,
      JSON.stringify(proposal.payload),
      JSON.stringify(proposal.basis),
      proposal.status,
      proposal.now,
    );
  return Number(result.lastInsertRowid);
};

/** An executed action, authorized by a permission or the principal (§8.2). Returns its id. */
export const insertAction = (
  db: Database.Database,
  proposalId: number,
  authorizedBy: string,
  now: string,
): number =>
  Number(
    db
      .prepare(
        `INSERT INTO actions (proposal_id, authorized_by, executed_at, status)
         VALUES (?, ?, ?, 'executed')`,
      )
      .run(proposalId, authorizedBy, now).lastInsertRowid,
  );

/**
 * §10 steps 5 to 7 in one transaction: proposal, action, expense and its assertions. Returns the
 * ids the verification step needs.
 */
export const registerTextExpense = (
  db: Database.Database,
  registration: TextExpenseRegistration,
): { expenseId: number; actionId: number } =>
  db.transaction(() => {
    const { now } = registration;
    const merchantId =
      registration.merchant === null ? null : findOrCreateMerchant(db, registration.merchant, now);
    const categoryId = categoryIdOf(db, registration.category);
    const proposalId = insertProposal(db, {
      payload: {
        total_cents: registration.total_cents,
        merchant: registration.merchant,
        occurred_on: registration.occurred_on,
        category: registration.category,
        category_basis: registration.category_basis,
      },
      basis: { source: registration.channelRef },
      status: 'executed',
      now,
    });
    const actionId = insertAction(db, proposalId, registration.authorized_by, now);
    const expense = db
      .prepare(
        `INSERT INTO expenses (merchant_id, occurred_on, total_cents, category_id, category_basis,
           mode, document_id, status, created_by_action_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'declared', NULL, 'current', ?, ?)`,
      )
      .run(
        merchantId,
        registration.occurred_on,
        registration.total_cents,
        categoryId,
        registration.category_basis,
        actionId,
        now,
      );
    const expenseId = Number(expense.lastInsertRowid);

    const declared = (predicate: string, value_json: AssertionDraft['value_json']) =>
      insertAssertion(
        db,
        {
          subject_type: 'expense',
          subject_id: expenseId,
          predicate,
          value_json,
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
    // R-2 AC1 and §7.1 rule 4: the amount is the principal's declaration.
    declared('total', registration.total_cents);
    if (registration.declaredCategory !== null) {
      declared('category', registration.declaredCategory);
    }
    for (const inference of registration.inferences) {
      insertAssertion(
        db,
        {
          ...inference,
          subject_type: 'expense',
          subject_id: expenseId,
          actor: 'processor',
          source: registration.processorSource,
          valid_at: registration.receivedAt,
          expires_at: null,
          status: 'current',
          supersedes_id: null,
          confirms_id: null,
        },
        now,
      );
    }
    return { expenseId, actionId };
  })();

export interface StoredExpense {
  total_cents: number;
  merchant: string | null;
  category: string | null;
  occurred_on: string;
  /** The sum of its purchase lines; 0 for a text expense. */
  lines_sum_cents: number;
}

/** R-9 AC1: the reply is built from this row, read back after registering. */
export const readExpense = (db: Database.Database, expenseId: number): StoredExpense => {
  const row = db
    .prepare<[number], StoredExpense>(
      `SELECT e.total_cents, m.name AS merchant, c.name AS category, e.occurred_on,
         (SELECT coalesce(sum(l.amount_cents), 0) FROM purchase_lines l WHERE l.expense_id = e.id)
           AS lines_sum_cents
       FROM expenses e
       LEFT JOIN entities m ON m.id = e.merchant_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.id = ?`,
    )
    .get(expenseId);
  if (!row) throw new Error(`expense ${expenseId} was not stored`);
  return row;
};

/**
 * R-9 AC2: the delivered reply is an observation about the action, linked as its verification.
 * Returns false when the action was already verified, so a repeated delivery changes nothing.
 */
export const recordReplyDelivery = (
  db: Database.Database,
  actionId: number,
  delivery: Delivery,
  text: string,
  now: string,
): boolean =>
  db.transaction(() => {
    const action = db
      .prepare<[number], { status: string }>('SELECT status FROM actions WHERE id = ?')
      .get(actionId);
    if (action?.status !== 'executed') return false;
    const observation = insertAssertion(
      db,
      {
        subject_type: 'action',
        subject_id: actionId,
        predicate: 'reply_delivered',
        value_json: { text },
        mode: 'observed',
        actor: 'source',
        source: delivery.channelRef,
        basis_json: null,
        confidence: null,
        valid_at: delivery.deliveredAt,
        expires_at: null,
        status: 'current',
        supersedes_id: null,
        confirms_id: null,
      },
      now,
    );
    db.prepare(
      "UPDATE actions SET verification_assertion_id = ?, status = 'verified' WHERE id = ?",
    ).run(observation, actionId);
    return true;
  })();
