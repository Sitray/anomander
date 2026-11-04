import type Database from 'better-sqlite3';
import { openPendingDecision } from './receipts.ts';

// §8.1: permissions the principal grants by answering "Sí" to a question, such as the morning
// digest (R-26) and the weekly summary (R-10). Code opens the question and stores what was
// answered, never a permission of its own. Granting one revokes the earlier ones for the same
// operation, so at most one is in force.

export interface PermissionRow {
  id: number;
  conditions_json: string;
  granted_at: string;
}

/** The permissions for `operation` in force at `now`, neither revoked nor expired, newest first. */
export const activePermissions = (
  db: Database.Database,
  operation: string,
  now: Date,
): PermissionRow[] =>
  db
    .prepare<[string, string], PermissionRow>(
      `SELECT id, conditions_json, granted_at FROM permissions
       WHERE operation = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id DESC`,
    )
    .all(operation, now.toISOString());

/** Revokes every permission for `operation` in force. Returns how many were revoked. */
export const revokePermissions = (db: Database.Database, operation: string, now: string): number =>
  db
    .prepare('UPDATE permissions SET revoked_at = ? WHERE operation = ? AND revoked_at IS NULL')
    .run(now, operation).changes;

/**
 * The principal's "Sí" grants `operation` with `conditions`, revoking any earlier one. Call it
 * inside the transaction that answers the decision. Returns the permission's id.
 */
export const grantPermission = (
  db: Database.Database,
  operation: string,
  conditions: Record<string, unknown>,
  now: string,
): number => {
  revokePermissions(db, operation, now);
  return Number(
    db
      .prepare('INSERT INTO permissions (operation, conditions_json, granted_at) VALUES (?, ?, ?)')
      .run(operation, JSON.stringify(conditions), now).lastInsertRowid,
  );
};

export interface GrantQuestion {
  /** The proposal's operation, such as `grant_morning_digest`. */
  operation: string;
  /** What "Sí" grants, read back by the answer handler. */
  payload: Record<string, unknown>;
  /** The PRD rule the proposal follows, kept as its basis. */
  rule: string;
  question: string;
  options: readonly string[];
  now: string;
}

/**
 * A proposal for `operation`, `asked`, and its pending decision; it belongs to no matter and
 * grants nothing until "Sí". An earlier question for the same operation still unanswered is
 * closed first, its proposal `rejected` and its decision `expired`, so only the latest can be
 * granted. Returns the decision.
 */
export const openGrantDecision = (db: Database.Database, ask: GrantQuestion): number =>
  db.transaction(() => {
    const unanswered = `SELECT d.proposal_id FROM pending_decisions d
       JOIN proposals p ON p.id = d.proposal_id
       WHERE p.operation = ? AND d.status IN ('open', 'awaiting_text')`;
    db.prepare(`UPDATE proposals SET status = 'rejected' WHERE id IN (${unanswered})`).run(
      ask.operation,
    );
    db.prepare(
      `UPDATE pending_decisions SET status = 'expired', awaiting_since = NULL
       WHERE status IN ('open', 'awaiting_text') AND proposal_id IN
         (SELECT id FROM proposals WHERE operation = ?)`,
    ).run(ask.operation);
    const proposal = db
      .prepare(
        `INSERT INTO proposals (matter_id, operation, payload_json, basis_json, status, created_at)
         VALUES (NULL, ?, ?, ?, 'asked', ?)`,
      )
      .run(ask.operation, JSON.stringify(ask.payload), JSON.stringify({ rule: ask.rule }), ask.now);
    return openPendingDecision(db, {
      proposalId: Number(proposal.lastInsertRowid),
      question: ask.question,
      options: ask.options,
      now: ask.now,
    });
  })();
