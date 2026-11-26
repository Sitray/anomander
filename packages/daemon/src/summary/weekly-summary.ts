import { todayIn } from '@anomander/core';
import { compareSums, type Money, type Notify, strings, sumByCurrency } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { activePermissions } from '../store/permissions.ts';

// R-10: the weekly summary. Every figure comes from the `expenses` rows, computed here, and S-9
// is sent exactly as written: no processor call, so it does not count against the AI budget.
// It is off by default: S-9 goes out only while the principal's permission is in force (AC5).

const DAY = 24 * 60 * 60 * 1000;

/** The operation the summary's permission covers (R-10 AC5, AC6). */
export const WEEKLY_SUMMARY_OPERATION = 'send_weekly_summary';

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
  // AC4: every existing category, also those with no expense that week (one row with no
  // currency). DK-25: every sum is kept per currency, never added across currencies.
  const perCategory = db.prepare<
    [string, string],
    { id: number; name: string; currency: string | null; cents: number }
  >(
    `SELECT c.id AS id, c.name AS name, e.currency AS currency,
       COALESCE(SUM(e.total_cents), 0) AS cents
     FROM categories c
     LEFT JOIN expenses e ON e.category_id = c.id AND e.status = 'current'
       AND e.occurred_on BETWEEN ? AND ?
     GROUP BY c.id, e.currency`,
  );
  const uncategorized = db.prepare<[string, string], Money>(
    `SELECT currency, SUM(total_cents) AS cents FROM expenses
     WHERE category_id IS NULL AND status = 'current' AND occurred_on BETWEEN ? AND ?
     GROUP BY currency`,
  );
  // AC2: pending when the summary is sent, whatever their week.
  const pending = db.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM expenses WHERE status = 'pending'",
  );

  return {
    send: async () => {
      const at = now();
      if (activePermissions(db, WEEKLY_SUMMARY_OPERATION, at).length === 0) return;
      const end = todayIn(timeZone, at);
      const start = daysBefore(end, 6);
      const byCategory = new Map<number, { name: string; amounts: Money[] }>();
      for (const { id, name, currency, cents } of perCategory.all(start, end)) {
        const entry = byCategory.get(id) ?? { name, amounts: [] };
        if (currency !== null) entry.amounts.push({ cents, currency });
        byCategory.set(id, entry);
      }
      const looseSpent = sumByCurrency(uncategorized.all(start, end));
      const perName = [...byCategory.values()].map(({ name, amounts }) => ({
        name,
        cents: sumByCurrency(amounts),
      }));
      const total = sumByCurrency([...perName.flatMap(({ cents }) => cents), ...looseSpent]);
      // B78: a category with no expense that week is zero in the week's first currency (the
      // principal's when it is there), so a week of euros never shows `0,00 US$`; a week with
      // none is zero in the principal's.
      const [first] = total;
      const zero = (cents: Money[]): Money[] =>
        cents.length === 0 && first !== undefined
          ? [{ cents: 0, currency: first.currency }]
          : cents;
      const spent = perName.map(({ name, cents }) => ({ name, cents: zero(cents) }));
      const loose = zero(looseSpent);
      const order = total.map(({ currency }) => currency);
      const categories = spent.sort(
        (a, b) => compareSums(a.cents, b.cents, order) || a.name.localeCompare(b.name),
      );
      const count = pending.get()?.count ?? 0;
      await notify({
        text: strings.weeklySummary(start, end, total, categories, loose, count),
      });
    },
  };
};
