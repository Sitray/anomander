import { formatWhenOnce, type Notify, strings } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { Logger } from '../processor/text-interpreter.ts';
import { readReminder } from '../store/reminders.ts';
import { latestOccurrence, localParts, nextOccurrence } from './when.ts';

// R-25 AC7: every minute and at startup, code sends each pending reminder whose time has come,
// unasked (R-16 AC3: `notify` records it as a turn). No processor call. A reminder is marked only
// after its send succeeded, so a failed one stays due and goes out on the next run; running twice
// sends nothing twice, since a sent one-time reminder is no longer pending and a repeating one has
// moved its `due_at` past now.

/** Sent later than this after its time, a reminder says when it was for (S-43). */
const LATE_MS = 10 * 60 * 1000;

export interface DueRemindersDeps {
  db: Database.Database;
  /** `TZ`: repetitions and S-43's `{cuando}` are read there. */
  timeZone: string;
  now: () => Date;
  /** Sends S-42 or S-43 to the principal. */
  notify: Notify;
  logger: Logger;
}

export interface DueReminders {
  /** R-25 AC7. */
  send(): Promise<void>;
}

export const createDueReminders = ({
  db,
  timeZone,
  now,
  notify,
  logger,
}: DueRemindersDeps): DueReminders => {
  // The shape of the `reminders_due` index; tasks have no `due_at` and are never sent.
  const due = db.prepare<[string], { id: number }>(
    `SELECT id FROM reminders WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= ?
     ORDER BY due_at, id`,
  );
  // Each update holds only if the reminder did not change while it was being sent.
  const markSent = db.prepare<[string, string, number, string]>(
    `UPDATE reminders SET status = 'sent', last_sent_at = ?, closed_at = ?
     WHERE id = ? AND status = 'pending' AND due_at = ?`,
  );
  const moveOn = db.prepare<[string, string, number, string]>(
    `UPDATE reminders SET due_at = ?, last_sent_at = ?
     WHERE id = ? AND status = 'pending' AND due_at = ?`,
  );

  return {
    send: async () => {
      const at = now();
      for (const { id } of due.all(at.toISOString())) {
        const reminder = readReminder(db, id);
        const dueAt = reminder.due_at as string;
        // A repeating reminder sends only its latest missed occurrence.
        const occurrence =
          reminder.recurrence === null
            ? new Date(dueAt)
            : latestOccurrence(reminder.recurrence, at, timeZone);
        let text = strings.reminderDue(reminder.text);
        if (at.getTime() - occurrence.getTime() > LATE_MS) {
          const { date, time } = localParts(occurrence, timeZone);
          const when = formatWhenOnce(date, time, localParts(at, timeZone).date);
          text = strings.reminderLate(when, reminder.text);
        }
        try {
          await notify({ text });
        } catch (error) {
          // R-25 AC12: ids and reasons only; the error may carry the message it failed to send.
          logger.error('could not send a reminder; it stays due', {
            reminderId: id,
            reason: (error as Error).message,
          });
          continue;
        }
        const sentAt = now().toISOString();
        if (reminder.recurrence === null) {
          markSent.run(sentAt, sentAt, id, dueAt);
        } else {
          const next = nextOccurrence(reminder.recurrence, at, timeZone).toISOString();
          moveOn.run(next, sentAt, id, dueAt);
        }
      }
    },
  };
};
