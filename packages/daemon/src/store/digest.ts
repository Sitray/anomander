import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  activePermissions,
  grantPermission,
  openGrantDecision,
  revokePermissions,
} from './permissions.ts';

// R-26: the morning digest. Its permission lives in `permissions` (§13), granted only by the
// principal's "Sí" to S-53 (§8.1): code opens the question and stores what was answered, never
// a permission of its own. The days it was sent are in `digest_sends` (AC6).

/** The operation the permission covers (R-26 AC2). */
export const DIGEST_OPERATION = 'send_morning_digest';

/** §13 `conditions_json` of the digest's permission: the local time in `TZ`. */
const conditionsSchema = z.object({ time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) });

/** The time in `conditions_json`; conditions code cannot read cover nothing. */
const timeOf = (json: string): string | null => {
  try {
    const conditions = conditionsSchema.safeParse(JSON.parse(json));
    return conditions.success ? conditions.data.time : null;
  } catch {
    return null;
  }
};

export interface DigestPermission {
  id: number;
  /** Local `HH:mm` in `TZ`. */
  time: string;
  granted_at: string;
}

/**
 * §8.1: the digest's permission in force at `now`, neither revoked nor expired, or `null` (off
 * by default, AC1). There is at most one, since granting one revokes the others; the latest is
 * taken all the same.
 */
export const activeDigestPermission = (
  db: Database.Database,
  now: Date,
): DigestPermission | null => {
  for (const { conditions_json, ...row } of activePermissions(db, DIGEST_OPERATION, now)) {
    const time = timeOf(conditions_json);
    if (time !== null) return { ...row, time };
  }
  return null;
};

/** R-26 AC2, AC4: revokes every digest permission in force. Returns how many were revoked. */
export const revokeDigestPermissions = (db: Database.Database, now: string): number =>
  revokePermissions(db, DIGEST_OPERATION, now);

/**
 * R-26 AC2: the principal's "Sí" grants the digest at `time`, revoking any earlier one. Call it
 * inside the transaction that answers the decision. Returns the permission's id.
 */
export const grantDigestPermission = (db: Database.Database, time: string, now: string): number =>
  grantPermission(db, DIGEST_OPERATION, { time }, now);

export interface DigestQuestion {
  /** Local `HH:mm` in `TZ`. */
  time: string;
  /** S-53. */
  question: string;
  options: readonly string[];
  now: string;
}

/**
 * R-26 AC1, AC3: a `grant_morning_digest` proposal, `asked`, naming the time, and its pending
 * decision. Nothing is granted until "Sí", and an earlier S-53 still unanswered is closed, so
 * only the latest time can be granted. Returns the decision.
 */
export const openDigestDecision = (db: Database.Database, ask: DigestQuestion): number =>
  openGrantDecision(db, {
    operation: 'grant_morning_digest',
    payload: { time: ask.time },
    rule: 'R-26 AC2',
    question: ask.question,
    options: ask.options,
    now: ask.now,
  });

/** R-26 AC6: whether the day (`YYYY-MM-DD` in `TZ`) already had its digest. */
export const digestHandled = (db: Database.Database, day: string): boolean =>
  db.prepare<[string], { day: string }>('SELECT day FROM digest_sends WHERE day = ?').get(day) !==
  undefined;

/** R-26 AC6: the day had its digest; a second call for the same day changes nothing. */
export const recordDigestSent = (db: Database.Database, day: string, sentAt: string): void => {
  db.prepare('INSERT OR IGNORE INTO digest_sends (day, sent_at) VALUES (?, ?)').run(day, sentAt);
};

/** R-26 AC5: the number of expenses whose status is `pending`. */
export const countPendingExpenses = (db: Database.Database): number =>
  (
    db
      .prepare<[], { n: number }>("SELECT count(*) AS n FROM expenses WHERE status = 'pending'")
      .get() as { n: number }
  ).n;
