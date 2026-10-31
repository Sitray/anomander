import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Recurrence } from '../reminders/when.ts';
import { insertAssertion } from './expenses.ts';

// R-25: reminders and tasks (§13 `reminders`). Each one rests on a `reminder` assertion declared
// by the principal; its text lives only in the reminders table, never in the ledger or a log.

/** The assertion points at the row that holds the text, as `memory` does (R-23 AC2). */
const REMINDER_VALUE = { text_in: 'reminders' };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** §13 `recurrence_json`: `daily`, `weekly` with `days` 1 Monday to 7 Sunday, or `monthly`. */
export const recurrenceSchema = z.discriminatedUnion('freq', [
  z.object({ freq: z.literal('daily'), time: z.string().regex(TIME) }),
  z.object({
    freq: z.literal('weekly'),
    days: z.array(z.int().min(1).max(7)).min(1),
    time: z.string().regex(TIME),
  }),
  z.object({
    freq: z.literal('monthly'),
    day: z.int().min(1).max(31),
    time: z.string().regex(TIME),
  }),
]);

/** One stored shape per repetition: weekly days sorted and once each. */
const canonical = (recurrence: Recurrence): Recurrence => {
  if (recurrence.freq === 'daily') return { freq: 'daily', time: recurrence.time };
  if (recurrence.freq === 'monthly') {
    return { freq: 'monthly', day: recurrence.day, time: recurrence.time };
  }
  const days = [...new Set(recurrence.days)].sort((a, b) => a - b);
  return { freq: 'weekly', days, time: recurrence.time };
};

export interface Reminder {
  id: number;
  text: string;
  /** Next time to send it, UTC; `null` for a task. */
  due_at: string | null;
  recurrence: Recurrence | null;
  status: 'pending' | 'sent' | 'done' | 'cancelled';
  created_at: string;
}

interface ReminderRow extends Omit<Reminder, 'recurrence'> {
  recurrence_json: string | null;
}

const fromRow = ({ recurrence_json, ...row }: ReminderRow): Reminder => ({
  ...row,
  recurrence: recurrence_json === null ? null : recurrenceSchema.parse(JSON.parse(recurrence_json)),
});

const SELECT_REMINDER =
  'SELECT id, text, due_at, recurrence_json, status, created_at FROM reminders';

export interface ReminderCapture {
  text: string;
  /** UTC; `null` for a task. */
  dueAt: string | null;
  recurrence: Recurrence | null;
  /** The principal's message, the source of the declaration. */
  source: string;
  receivedAt: string;
  now: string;
}

/**
 * R-25 AC2, AC5: stores a reminder, or a task when it has no time, and its `reminder` assertion
 * declared by the principal, in one transaction. The assertion is about the reminder, so its id is
 * taken first; rows are never deleted, so the next id is one past the largest. Returns the id.
 */
export const createReminder = (db: Database.Database, capture: ReminderCapture): number =>
  db.transaction(() => {
    const { id } = db
      .prepare<[], { id: number }>('SELECT coalesce(max(id), 0) + 1 AS id FROM reminders')
      .get() as { id: number };
    const declaredBy = insertAssertion(
      db,
      {
        subject_type: 'reminder',
        subject_id: id,
        predicate: 'reminder',
        value_json: REMINDER_VALUE,
        mode: 'declared',
        actor: 'principal',
        source: capture.source,
        basis_json: null,
        confidence: null,
        valid_at: capture.receivedAt,
        expires_at: null,
        status: 'current',
        supersedes_id: null,
        confirms_id: null,
      },
      capture.now,
    );
    db.prepare(
      `INSERT INTO reminders (id, text, due_at, recurrence_json, status, declared_by_assertion_id,
         created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      id,
      capture.text,
      capture.dueAt,
      capture.recurrence === null ? null : JSON.stringify(canonical(capture.recurrence)),
      declaredBy,
      capture.now,
    );
    return id;
  })();

export const readReminder = (db: Database.Database, id: number): Reminder => {
  const row = db.prepare<[number], ReminderRow>(`${SELECT_REMINDER} WHERE id = ?`).get(id);
  if (row === undefined) throw new Error(`reminder ${id} not found`);
  return fromRow(row);
};

export interface TaskSchedule {
  /** UTC. */
  dueAt: string;
  recurrence: Recurrence | null;
}

/**
 * R-25 AC5: a pending task gets a time and becomes a reminder; the row and its assertion stay,
 * only `due_at` and `recurrence_json` change. Returns whether it was still a pending task.
 */
export const scheduleTask = (db: Database.Database, id: number, schedule: TaskSchedule): boolean =>
  db
    .prepare(
      `UPDATE reminders SET due_at = ?, recurrence_json = ?
       WHERE id = ? AND status = 'pending' AND due_at IS NULL`,
    )
    .run(
      schedule.dueAt,
      schedule.recurrence === null ? null : JSON.stringify(canonical(schedule.recurrence)),
      id,
    ).changes === 1;

/**
 * R-25 AC9: each given reminder or task still pending becomes `cancelled` and its `reminder`
 * assertion `expired`. Call it inside the transaction that answers the decision. Returns the ids
 * cancelled.
 */
export const cancelReminders = (
  db: Database.Database,
  ids: readonly number[],
  now: string,
): number[] =>
  ids.filter((id) => {
    const changed = db
      .prepare(
        "UPDATE reminders SET status = 'cancelled', closed_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(now, id).changes;
    if (changed !== 1) return false;
    db.prepare(
      `UPDATE assertions SET status = 'expired'
       WHERE id = (SELECT declared_by_assertion_id FROM reminders WHERE id = ?)`,
    ).run(id);
    return true;
  });

/**
 * R-25 AC10: each given reminder or task still pending becomes `done`; the row is kept, never
 * deleted. Returns the ids marked done.
 */
export const markDone = (db: Database.Database, ids: readonly number[], now: string): number[] =>
  db.transaction(() =>
    ids.filter(
      (id) =>
        db
          .prepare(
            "UPDATE reminders SET status = 'done', closed_at = ? WHERE id = ? AND status = 'pending'",
          )
          .run(now, id).changes === 1,
    ),
  )();

/** R-25 AC1, AC8: pending reminders, soonest first, then pending tasks, oldest first. */
export const listPending = (db: Database.Database): Reminder[] =>
  db
    .prepare<[], ReminderRow>(
      `${SELECT_REMINDER} WHERE status = 'pending' ORDER BY due_at IS NULL, due_at, id`,
    )
    .all()
    .map(fromRow);
