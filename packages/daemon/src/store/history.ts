import type Database from 'better-sqlite3';
import { localParts } from '../reminders/when.ts';
import { forgetTurnsSaying } from './memory.ts';

// DK-14 (docs/desktop-prd.md): what ANOMANDER did for the principal, kept in the local database
// (`action_history`, migration `0008`) so it can answer "¿qué hiciste ayer?". A row holds the
// principal's words and how the action ended, never what was typed, captured or answered.
// Expenses are not here: they live in the ledger. Nothing here logs a row's words.

/** AC3: the text interpreter gets at most this many actions… */
export const HISTORY_PROMPT_LIMIT = 20;
/** …and none that ended more than this many days ago. */
export const HISTORY_PROMPT_DAYS = 7;

const DAY_MS = 86_400_000;

export type ActionKind = 'screen' | 'computer' | 'connect';
export type ActionDoor = 'app' | 'telegram';

/** A call of a task with connections: which tool of which server, and whether it was allowed. */
export interface ActionCall {
  server: string;
  tool: string;
  allowed: boolean;
}

export interface ActionRecord {
  kind: ActionKind;
  door: ActionDoor;
  /** The principal's words: the question about the screen or the task. */
  task: string;
  /** How it ended, as a code word. */
  outcome: string;
  /** A task on the computer: the steps performed. */
  steps: number | null;
  /** A task with connections: the calls code decided. */
  calls: readonly ActionCall[] | null;
  /** UTC. */
  endedAt: string;
}

/** An action as the text interpreter reads it: `when` it ended in `TZ`, `YYYY-MM-DD HH:mm`. */
export interface HistoryEntry {
  when: string;
  what: ActionKind;
  door: ActionDoor;
  task: string;
  outcome: string;
  steps?: number;
  calls?: ActionCall[];
}

/** AC2: stores one action that ended. */
export const recordAction = (db: Database.Database, record: ActionRecord): void => {
  db.prepare(
    `INSERT INTO action_history (kind, door, task, outcome, steps, calls_json, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.kind,
    record.door,
    record.task,
    record.outcome,
    record.steps,
    record.calls === null ? null : JSON.stringify(record.calls),
    record.endedAt,
  );
};

interface Row {
  kind: ActionKind;
  door: ActionDoor;
  task: string;
  outcome: string;
  steps: number | null;
  calls_json: string | null;
  ended_at: string;
}

/**
 * AC3: the latest actions, at most 20 and none older than 7 days, oldest first, each with when
 * it ended in `timeZone`.
 */
export const historyForPrompt = (
  db: Database.Database,
  timeZone: string,
  now: Date,
): HistoryEntry[] => {
  const since = new Date(now.getTime() - HISTORY_PROMPT_DAYS * DAY_MS).toISOString();
  const rows = db
    .prepare<[string, number], Row>(
      `SELECT kind, door, task, outcome, steps, calls_json, ended_at FROM action_history
       WHERE ended_at >= ? ORDER BY ended_at DESC, id DESC LIMIT ?`,
    )
    .all(since, HISTORY_PROMPT_LIMIT);
  return rows.reverse().map((row) => {
    const { date, time } = localParts(new Date(row.ended_at), timeZone);
    return {
      when: `${date} ${time}`,
      what: row.kind,
      door: row.door,
      task: row.task,
      outcome: row.outcome,
      ...(row.steps === null ? {} : { steps: row.steps }),
      ...(row.calls_json === null ? {} : { calls: JSON.parse(row.calls_json) as ActionCall[] }),
    };
  });
};

/** AC4: the id of the latest action, `null` when there is none. */
export const lastActionId = (db: Database.Database): number | null =>
  db.prepare<[], { id: number | null }>('SELECT max(id) AS id FROM action_history').get()?.id ??
  null;

/** AC4: how many actions are kept. */
export const countActions = (db: Database.Database): number =>
  db.prepare<[], { count: number }>('SELECT count(*) AS count FROM action_history').get()?.count ??
  0;

/**
 * AC4: erases every action up to `upToId`, the latest one when the principal was asked, so one
 * that ended after the question stays. Then the WAL is checkpointed and truncated, as a forgotten
 * memory's is (R-23 AC7): with `secure_delete` on, the freed pages hold zeros. Returns how many
 * were erased.
 */
export const forgetHistory = (db: Database.Database, upToId: number): number => {
  const { changes } = db.prepare('DELETE FROM action_history WHERE id <= ?').run(upToId);
  if (changes > 0) db.pragma('wal_checkpoint(TRUNCATE)');
  return changes;
};

/** DK-18: one action as the window lists it, without its steps or calls. */
export interface KeptAction {
  id: number;
  kind: ActionKind;
  door: ActionDoor;
  task: string;
  outcome: string;
  /** UTC. */
  endedAt: string;
}

/** DK-18: every action kept, the latest first. */
export const listActions = (db: Database.Database): KeptAction[] =>
  db
    .prepare<[], KeptAction>(
      `SELECT id, kind, door, task, outcome, ended_at AS endedAt FROM action_history
       ORDER BY ended_at DESC, id DESC`,
    )
    .all();

/**
 * DK-18 AC5 (decided by the principal on 2026-11-24: "Solo los mensajes que lo contienen"):
 * erases the one action `id` and the turns of the stored conversation that say its task, as a
 * replaced memory's are found (R-23 AC3): a principal's own message that holds the task's words,
 * or a reply that holds the whole task, each with its turn. Then the WAL is checkpointed as
 * `forgetHistory` does: with `secure_delete` on, the freed pages hold zeros. Returns whether it
 * was there.
 */
export const forgetAction = (db: Database.Database, id: number): boolean => {
  const erased = db.transaction(() => {
    const row = db
      .prepare<[number], { task: string }>('SELECT task FROM action_history WHERE id = ?')
      .get(id);
    if (row === undefined) return false;
    forgetTurnsSaying(db, { text: row.task, quote: row.task });
    db.prepare('DELETE FROM action_history WHERE id = ?').run(id);
    return true;
  })();
  if (erased) db.pragma('wal_checkpoint(TRUNCATE)');
  return erased;
};

/**
 * T14, security audit L3: the retention job (R-19 AC6) erases the actions that ended before
 * `before`, and checkpoints the WAL as `forgetHistory` does. Returns how many were erased.
 */
export const forgetActionsEndedBefore = (db: Database.Database, before: string): number => {
  const { changes } = db.prepare('DELETE FROM action_history WHERE ended_at < ?').run(before);
  if (changes > 0) db.pragma('wal_checkpoint(TRUNCATE)');
  return changes;
};
