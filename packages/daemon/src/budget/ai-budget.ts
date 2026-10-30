import { todayIn } from '@anomander/core';
import type Database from 'better-sqlite3';
import type { Complete } from '../processor/text-interpreter.ts';

// R-12: `ANOMANDER_DAILY_AI_CALL_LIMIT` caps processor calls per day in `TZ`. The count lives in
// `ai_usage` (PRD §13), so a restart does not reset it.

export interface AiBudgetDeps {
  db: Database.Database;
  /** `ANOMANDER_DAILY_AI_CALL_LIMIT` (R-12 AC1). */
  limit: number;
  /** `TZ`: the day changes at midnight there (R-12 AC3). */
  timeZone: string;
  now: () => Date;
}

export interface AiBudget {
  /** Counts one processor call against today's cap; `false`, and nothing counted, past it. */
  tryConsume(): boolean;
  /** `true` only the first time it is asked on a day: S-10 goes out once that day (R-12 AC2). */
  claimLimitNotice(): boolean;
}

export const createAiBudget = ({ db, limit, timeZone, now }: AiBudgetDeps): AiBudget => {
  const ensureDay = db.prepare('INSERT OR IGNORE INTO ai_usage (day, calls) VALUES (?, 0)');
  const consume = db.prepare('UPDATE ai_usage SET calls = calls + 1 WHERE day = ? AND calls < ?');
  const notify = db.prepare(
    'UPDATE ai_usage SET limit_notified = 1 WHERE day = ? AND limit_notified = 0',
  );
  const today = () => todayIn(timeZone, now());

  return {
    tryConsume: db.transaction(() => {
      const day = today();
      ensureDay.run(day);
      return consume.run(day, limit).changes === 1;
    }),
    claimLimitNotice: db.transaction(() => {
      const day = today();
      ensureDay.run(day);
      return notify.run(day).changes === 1;
    }),
  };
};

export class AiBudgetExhaustedError extends Error {
  constructor() {
    super('the daily AI budget is exhausted (R-12)');
    this.name = 'AiBudgetExhaustedError';
  }
}

/**
 * A processor call that counts against the budget and is refused, without calling the
 * processor, once the cap is reached (R-12 AC2, R-21 AC4). Callers already treat a thrown call
 * as a failed one: the phraser sends the §12 string, the interpreters report a failure.
 */
export const budgeted =
  <M>(complete: Complete<M>, budget: AiBudget): Complete<M> =>
  (model, context) => {
    if (!budget.tryConsume()) return Promise.reject(new AiBudgetExhaustedError());
    return complete(model, context);
  };
