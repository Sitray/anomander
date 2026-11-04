import { type Notify, strings } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { Logger } from '../processor/text-interpreter.ts';
import { localParts, utcOf } from '../reminders/when.ts';
import {
  activeDigestPermission,
  countPendingExpenses,
  digestHandled,
  recordDigestSent,
} from '../store/digest.ts';
import { listPending } from '../store/reminders.ts';

// R-26 AC5, AC6: every minute and at startup, while the digest's permission is in force, code
// sends S-57 at its time in `TZ`, unasked (R-16 AC3: `notify` records it as a turn). It is built
// from the store alone: no processor call and no AI budget. A day is marked in `digest_sends` only
// after its send succeeded, so a failed one is tried again on the next run; jobs never overlap, so
// a day never gets two.
//
// A day when every part is empty sends nothing and is marked all the same: its digest was the
// empty one, so something added later that morning does not bring a "Buenos días" at 10:00.
// A permission granted after its time today first sends tomorrow: the principal was not asking
// for a digest of a morning already gone.

/** A run this long after the digest's time still counts as on time, as for S-43 (assumption). */
const ON_TIME_MS = 10 * 60 * 1000;

/** AC6: a digest missed while the daemon was down goes out at startup only before this, in `TZ`. */
const MISSED_UNTIL = '12:00';

export interface MorningDigestDeps {
  db: Database.Database;
  /** `TZ`: the digest's time and "today" are read there. */
  timeZone: string;
  now: () => Date;
  /** Sends S-57 to the principal. */
  notify: Notify;
  logger: Logger;
}

export interface MorningDigestJob {
  /** R-26 AC5, AC6. */
  send(): Promise<void>;
}

export const createMorningDigest = ({
  db,
  timeZone,
  now,
  notify,
  logger,
}: MorningDigestDeps): MorningDigestJob => ({
  send: async () => {
    const at = now();
    const permission = activeDigestPermission(db, at);
    if (permission === null) return;
    const { date: today, time: localNow } = localParts(at, timeZone);
    if (digestHandled(db, today)) return;
    const dueAt = utcOf(today, permission.time, timeZone);
    if (at < dueAt || dueAt.toISOString() < permission.granted_at) return;
    if (at.getTime() - dueAt.getTime() > ON_TIME_MS && localNow >= MISSED_UNTIL) return;

    // Today's pending reminders from now on, soonest first, then every task, oldest first, as
    // `listPending` orders them. One due by now goes out as S-42 instead.
    const pending = listPending(db);
    const todays = pending.flatMap(({ due_at, text }) => {
      if (due_at === null || due_at <= at.toISOString()) return [];
      const local = localParts(new Date(due_at), timeZone);
      return local.date === today ? [{ time: local.time, text }] : [];
    });
    const tasks = pending.filter(({ due_at }) => due_at === null).map(({ text }) => text);
    const pendingExpenses = countPendingExpenses(db);

    if (todays.length === 0 && tasks.length === 0 && pendingExpenses === 0) {
      logger.info('morning digest: nothing to send today', { day: today });
      recordDigestSent(db, today, at.toISOString());
      return;
    }
    try {
      await notify({ text: strings.morningDigest({ today: todays, tasks, pendingExpenses }) });
    } catch (error) {
      // R-26 AC7: the day and the reason only; the error may carry the message it failed to send.
      logger.error('could not send the morning digest; it is tried again', {
        day: today,
        reason: (error as Error).message,
      });
      return;
    }
    recordDigestSent(db, today, now().toISOString());
  },
});
