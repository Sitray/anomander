import type Database from 'better-sqlite3';
import { z } from 'zod';
import { expensesMatterId, insertAssertion } from './expenses.ts';
import { openPendingDecision } from './receipts.ts';

// R-13: policies are declared only by the principal (§13). The processor or code may propose
// one, through S-11 or S-12; it is stored only after "Sí".

/** R-13 AC2: a pattern needs this many current expenses with the same category. */
export const PATTERN_THRESHOLD = 3;

const normalize = (name: string): string => name.trim().toLowerCase();

const ruleSchema = z.object({ merchant: z.string(), category: z.string() });

interface ActivePolicy {
  id: number;
  merchant: string;
  category: string;
  declared_by_assertion_id: number;
}

/** The active policies for the merchant, matched as `categorize` does (R-5 AC1). */
const activePoliciesFor = (db: Database.Database, merchant: string): ActivePolicy[] =>
  db
    .prepare<[], { id: number; rule_json: string; declared_by_assertion_id: number }>(
      'SELECT id, rule_json, declared_by_assertion_id FROM policies WHERE active = 1 ORDER BY id',
    )
    .all()
    .flatMap(({ rule_json, ...row }) => {
      const rule = ruleSchema.safeParse(JSON.parse(rule_json));
      return rule.success && normalize(rule.data.merchant) === normalize(merchant)
        ? [{ ...row, ...rule.data }]
        : [];
    });

/** Whether the merchant already has an active policy, for that category when one is given. */
export const hasActivePolicy = (
  db: Database.Database,
  merchant: string,
  category?: string,
): boolean =>
  activePoliciesFor(db, merchant).some(
    (policy) => category === undefined || normalize(policy.category) === normalize(category),
  );

export interface PolicyDeclaration {
  merchant: string;
  /** An existing category, lowercase. */
  category: string;
  /** Where the principal declared it: their message (S-11) or the pressed button (S-12). */
  source: string;
  now: string;
}

/**
 * R-13 AC1, AC2: the principal's "Sí" stores the policy, with the `declared` assertion it rests
 * on. A policy for the same merchant with another category is revoked and its declaration
 * refuted, superseded by the new one; the same rule already active is kept as it is. Returns the
 * declaration that answers the decision, or `null` when the rule was already active.
 */
export const declarePolicy = (
  db: Database.Database,
  declaration: PolicyDeclaration,
): number | null =>
  db.transaction(() => {
    const { merchant, category, source, now } = declaration;
    const active = activePoliciesFor(db, merchant);
    if (active.some((policy) => normalize(policy.category) === category)) return null;
    const superseded = active.at(-1)?.declared_by_assertion_id ?? null;
    const rule = { merchant, category };
    const declared = insertAssertion(
      db,
      {
        subject_type: 'policy',
        subject_id: null,
        predicate: 'rule',
        value_json: rule,
        mode: 'declared',
        actor: 'principal',
        source,
        basis_json: null,
        confidence: null,
        valid_at: now,
        expires_at: null,
        status: 'current',
        supersedes_id: superseded,
        confirms_id: null,
      },
      now,
    );
    const revoke = db.prepare(
      'UPDATE policies SET active = 0, revoked_at = ? WHERE id = ? AND active = 1',
    );
    const refute = db.prepare("UPDATE assertions SET status = 'refuted' WHERE id = ?");
    for (const policy of active) {
      revoke.run(now, policy.id);
      refute.run(policy.declared_by_assertion_id);
    }
    db.prepare(
      'INSERT INTO policies (rule_json, declared_by_assertion_id, created_at) VALUES (?, ?, ?)',
    ).run(JSON.stringify(rule), declared, now);
    return declared;
  })();

export interface CreatePolicyQuestion {
  merchant: string;
  /** An existing category, lowercase. */
  category: string;
  /** R-13 AC1: the principal's message; `null` for a pattern (AC2), declared by the button. */
  source: string | null;
  /** The proposal's basis: the rule and what it rests on. */
  basis: Record<string, unknown>;
  /** S-11 or S-12. */
  question: string;
  options: readonly string[];
  now: string;
}

/**
 * R-13 AC1, AC2: a `create_policy` proposal, `asked`, in the "Keep my expenses" matter, and its
 * pending decision. Nothing is stored until the principal answers "Sí". Returns the decision.
 */
export const openCreatePolicyDecision = (
  db: Database.Database,
  ask: CreatePolicyQuestion,
): number =>
  db.transaction(() => {
    const proposal = db
      .prepare(
        `INSERT INTO proposals (matter_id, operation, payload_json, basis_json, status, created_at)
         VALUES (?, 'create_policy', ?, ?, 'asked', ?)`,
      )
      .run(
        expensesMatterId(db),
        JSON.stringify({ merchant: ask.merchant, category: ask.category, source: ask.source }),
        JSON.stringify(ask.basis),
        ask.now,
      );
    return openPendingDecision(db, {
      proposalId: Number(proposal.lastInsertRowid),
      question: ask.question,
      options: ask.options,
      now: ask.now,
    });
  })();

export interface PatternCandidate {
  /** The merchant's name as stored. */
  merchant: string;
  category: string;
  /** The current expenses the pattern rests on, oldest first. */
  expenseIds: number[];
}

/**
 * R-13 AC2: the pattern the expense completes, if any. An expense counts when it is `current`
 * and the principal declared its category (`category_basis = 'declared'`: written in a text, a
 * caption or a correction) or confirmed it (`category_basis = 'inferred'` with `mode =
 * 'confirmed'`: "Apuntar" or a correction confirmed the inferred category). There is a pattern
 * when the expense counts, its merchant and category have at least 3 counting expenses, the
 * merchant has no active policy, and the same pattern is neither waiting for an answer nor was
 * rejected by the principal. An S-12 left unanswered until it expired was not rejected.
 */
export const findPattern = (db: Database.Database, expenseId: number): PatternCandidate | null => {
  const counts = `e.status = 'current' AND e.category_id IS NOT NULL AND e.merchant_id IS NOT NULL
    AND (e.category_basis = 'declared' OR (e.category_basis = 'inferred' AND e.mode = 'confirmed'))`;
  const expense = db
    .prepare<
      [number],
      { merchant_id: number; category_id: number; merchant: string; category: string }
    >(
      `SELECT e.merchant_id, e.category_id, m.name AS merchant, c.name AS category
       FROM expenses e JOIN entities m ON m.id = e.merchant_id
       JOIN categories c ON c.id = e.category_id
       WHERE e.id = ? AND ${counts}`,
    )
    .get(expenseId);
  if (expense === undefined || hasActivePolicy(db, expense.merchant)) return null;
  const expenseIds = db
    .prepare<[number, number], { id: number }>(
      `SELECT e.id FROM expenses e WHERE e.merchant_id = ? AND e.category_id = ? AND ${counts}
       ORDER BY e.id`,
    )
    .all(expense.merchant_id, expense.category_id)
    .map(({ id }) => id);
  if (expenseIds.length < PATTERN_THRESHOLD) return null;

  const blocked = db
    .prepare<[], { payload_json: string }>(
      `SELECT p.payload_json FROM proposals p JOIN pending_decisions d ON d.proposal_id = p.id
       WHERE p.operation = 'create_policy'
         AND (d.status IN ('open', 'awaiting_text')
           OR (d.status = 'answered' AND p.status = 'rejected'
             AND json_extract(p.basis_json, '$.rule') = 'R-13 AC2'))`,
    )
    .all()
    .some(({ payload_json }) => {
      const rule = ruleSchema.safeParse(JSON.parse(payload_json));
      return (
        rule.success &&
        normalize(rule.data.merchant) === normalize(expense.merchant) &&
        normalize(rule.data.category) === expense.category
      );
    });
  return blocked ? null : { merchant: expense.merchant, category: expense.category, expenseIds };
};
