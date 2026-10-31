import { todayIn } from '@anomander/core';
import { type Notify, strings } from '@anomander/protocol';
import type Database from 'better-sqlite3';

// R-10: the weekly summary. Every figure comes from the `expenses` rows, computed here, and S-9
// is sent exactly as written: no processor call, so it does not count against the AI budget.

const DAY = 24 * 60 * 60 * 1000;

export interface WeeklySummaryDeps {
  db: Database.Database;
  /** `TZ`: the summary covers the 7 days that end today there. */
  timeZone: string;
  now: () => Date;
  /** Sends S-9 to the principal. */
  notify: Notify;
}

export interface WeeklySummary {
  /** R-10 AC2 to AC4. */
  send(): Promise<void>;
}

/** `YYYY-MM-DD` `days` days before `isoDate`. */
const daysBefore = (isoDate: string, days: number): string =>
  new Date(Date.parse(`${isoDate}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);

export const createWeeklySummary = ({
  db,
  timeZone,
  now,
  notify,
}: WeeklySummaryDeps): WeeklySummary => {
  // AC4: every existing category, also those with no expense that week.
  const perCategory = db.prepare<[string, string], { name: string; cents: number }>(
    `SELECT c.name AS name, COALESCE(SUM(e.total_cents), 0) AS cents
     FROM categories c
     LEFT JOIN expenses e ON e.category_id = c.id AND e.status = 'current'
       AND e.occurred_on BETWEEN ? AND ?
     GROUP BY c.id`,
  );
  const uncategorized = db.prepare<[string, string], { cents: number }>(
    `SELECT COALESCE(SUM(total_cents), 0) AS cents FROM expenses
     WHERE category_id IS NULL AND status = 'current' AND occurred_on BETWEEN ? AND ?`,
  );
  // AC2: pending when the summary is sent, whatever their week.
  const pending = db.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM expenses WHERE status = 'pending'",
  );

  return {
    send: async () => {
      const end = todayIn(timeZone, now());
      const start = daysBefore(end, 6);
      const categories = perCategory
        .all(start, end)
        .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
      const loose = uncategorized.get(start, end)?.cents ?? 0;
      const total = categories.reduce((sum, { cents }) => sum + cents, loose);
      const count = pending.get()?.count ?? 0;
      await notify({
        text: strings.weeklySummary(start, end, total, categories, loose, count),
      });
    },
  };
};
