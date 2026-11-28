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

// DK-24: "Permitir siempre" on a call of a task with connections. A grant the principal gives by
// pressing it, one row per tool of a server: `conditions_json` holds the server's name, the
// tool, the server's identity (`serverIdentity`) and the door it was pressed at. It has no
// expiry: it holds until "Quitar" or until its server is removed or changes. Granting one never
// revokes another.

/** The operation of a "Permitir siempre". */
export const CONNECTION_TOOL_OPERATION = 'call_connection_tool';

/** One tool of one server, as it is configured now. */
export interface ConnectionTool {
  server: string;
  tool: string;
  identity: string;
}

/** A "Permitir siempre" in force. */
export interface ConnectionToolGrant extends ConnectionTool {
  id: number;
  grantedAt: string;
}

const isConnectionTool = (value: unknown): value is ConnectionTool & { door?: unknown } => {
  const { server, tool, identity } = (value ?? {}) as Record<string, unknown>;
  return typeof server === 'string' && typeof tool === 'string' && typeof identity === 'string';
};

/** What `json` holds; `undefined` when it is not JSON. */
const parsedOrNone = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

/**
 * Every "Permitir siempre" in force, by server and then tool. One whose conditions cannot be
 * read is none: it grants nothing and stops no other (B67).
 */
export const connectionToolGrants = (db: Database.Database): ConnectionToolGrant[] =>
  activePermissions(db, CONNECTION_TOOL_OPERATION, new Date())
    .flatMap(({ id, conditions_json, granted_at }) => {
      const conditions = parsedOrNone(conditions_json);
      if (!isConnectionTool(conditions)) return [];
      const { server, tool, identity } = conditions;
      return [{ id, server, tool, identity, grantedAt: granted_at }];
    })
    .sort((a, b) => a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool));

/** Whether the principal allowed `call` always, for that server as it is now. */
export const connectionToolGranted = (db: Database.Database, call: ConnectionTool): boolean =>
  connectionToolGrants(db).some(
    (grant) =>
      grant.server === call.server && grant.tool === call.tool && grant.identity === call.identity,
  );

/**
 * The principal pressed "Permitir siempre" on a call of `call`, at `door`. One already in force
 * for it is kept. Returns the grant's id.
 */
export const grantConnectionTool = (
  db: Database.Database,
  call: ConnectionTool,
  door: string,
  now: string,
): number =>
  db.transaction(() => {
    const kept = connectionToolGrants(db).find(
      (grant) =>
        grant.server === call.server &&
        grant.tool === call.tool &&
        grant.identity === call.identity,
    );
    if (kept !== undefined) return kept.id;
    const { server, tool, identity } = call;
    return Number(
      db
        .prepare(
          'INSERT INTO permissions (operation, conditions_json, granted_at) VALUES (?, ?, ?)',
        )
        .run(CONNECTION_TOOL_OPERATION, JSON.stringify({ server, tool, identity, door }), now)
        .lastInsertRowid,
    );
  })();

/** "Quitar": revokes the "Permitir siempre" `id`; nothing when it is not one in force. */
export const revokeConnectionTool = (db: Database.Database, id: number, now: string): void => {
  db.prepare(
    'UPDATE permissions SET revoked_at = ? WHERE id = ? AND operation = ? AND revoked_at IS NULL',
  ).run(now, id, CONNECTION_TOOL_OPERATION);
};

/**
 * Revokes every "Permitir siempre" of a server `identities` (name to identity) does not hold as
 * it is: removed, renamed, or with another command or address. Returns how many were revoked.
 */
export const revokeConnectionToolsNotIn = (
  db: Database.Database,
  identities: Readonly<Record<string, string>>,
  now: string,
): number => {
  const gone = connectionToolGrants(db).filter(
    ({ server, identity }) => !Object.hasOwn(identities, server) || identities[server] !== identity,
  );
  for (const { id } of gone) revokeConnectionTool(db, id, now);
  return gone.length;
};
