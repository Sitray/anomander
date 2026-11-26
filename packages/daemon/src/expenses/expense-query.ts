import { todayIn } from '@anomander/core';
import {
  compareSums,
  type ExpenseQueryAnswer,
  foldCareful,
  type Money,
  type Reply,
  strings,
  subtractByCurrency,
  sumByCurrency,
} from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { type CapabilityEnv, defineCapability } from '../capabilities/capability.ts';
import { categoryIdOf } from '../store/expenses.ts';
import { quotedFrom } from '../store/memory.ts';

// R-30: a free query on the expenses ("¿cuánto llevo gastado este mes?"), the fourth capability
// (R-24). The processor only picks the period and the filters; code checks them and computes
// every figure from the current `expenses` rows, as the weekly summary does (R-10), so no figure
// ever comes from the model. Reading the principal's own data needs no confirmation (R-24 AC3).

/** A real calendar date, `YYYY-MM-DD`. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    const parsed = Date.parse(`${date}T00:00:00Z`);
    return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
  });

// AC2: unknown keys, such as a total the processor computed, are dropped here. A `from` of
// `null` is "en total": the period starts at the first expense (AC1).
const callSchema = z
  .object({
    kind: z.literal('expense_query'),
    from: isoDate.nullable(),
    to: isoDate,
    category: z.string().trim().min(1).nullish(),
    merchant: z.string().trim().min(1).nullish(),
  })
  .refine(({ from, to }) => from === null || from <= to, { path: ['to'] });

type ExpenseQueryCall = z.infer<typeof callSchema>;

const PROMPT = `If the user asks how much they spent or how many expenses they have in a period ("¿cuánto llevo gastado este mes?", "¿cuánto gasté la semana pasada?", "¿cuánto llevo en supermercado en octubre?", "¿cuánto gasté ayer en Mercadona?"), reply:
{"kind":"expense_query","from":"YYYY-MM-DD"|null,"to":"YYYY-MM-DD","category":"<name>"|null,"merchant":"<merchant>"|null}
Resolve the period from the "today" and "weekday" fields: "este mes" is from the first day of this month to today, "este año" is from 1 January of this year to today, "la semana pasada" is last Monday to Sunday, "en octubre" is the whole month, "ayer" and "hoy" are one day (from equals to), and "en total", "desde siempre" or no period at all is "from": null with "to" today. A month named without a year is the latest one that is not after today: "en diciembre" asked in January is December of last year. A period never ends after today. "category" is one of "categories" when the user names it, also after "en" or with a short form: "en el super" or "en el súper" is "supermercado" and "en restaurantes" is "restaurantes" when those are in "categories"; then "merchant" is null. "merchant" is the merchant exactly as the user wrote it, only when they name one that is not a category ("en Mercadona", "en la Cafetería Luna"). Never compute or include any amount or count: the assistant computes every figure.`;

/** AC3: how many merchants a category's answer lists (assumption). */
const TOP_MERCHANTS = 3;

/** Spent per name (a category or a merchant), as `{desglose}` lists it, per currency. */
interface Spent {
  name: string | null;
  cents: Money[];
}

/** One row of a sum grouped by a key and the currency. */
interface SpentRow extends Money {
  key: number | null;
  name: string | null;
}

/** As SQLite's `ORDER BY name` compares text: byte by byte. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Folds the rows of each key into one sum per currency (DK-25), and orders them as `{desglose}`
 * does: an unnamed key last, the largest sum first in the currencies of `order`, then by name.
 */
const spentBy = (rows: readonly SpentRow[], order: readonly string[]): Spent[] => {
  const keys = new Map<number | null, { name: string | null; amounts: Money[] }>();
  for (const { key, name, cents, currency } of rows) {
    const entry = keys.get(key) ?? { name, amounts: [] };
    entry.amounts.push({ cents, currency });
    keys.set(key, entry);
  }
  return [...keys.values()]
    .map(({ name, amounts }) => ({ name, cents: sumByCurrency(amounts) }))
    .sort(
      (a, b) =>
        Number(a.name === null) - Number(b.name === null) ||
        compareSums(a.cents, b.cents, order) ||
        byName(a.name ?? '', b.name ?? ''),
    );
};

/** The ids of the merchants whose name contains `text`, ignoring case and accents (AC3). */
const merchantsMatching = (db: Database.Database, text: string): number[] => {
  const wanted = foldCareful(text);
  return db
    .prepare<[], { id: number; name: string }>(
      "SELECT id, name FROM entities WHERE kind = 'merchant'",
    )
    .all()
    .filter(({ name }) => foldCareful(name).includes(wanted))
    .map(({ id }) => id);
};

/** AC1: the first day with an expense that is current or pending, or `today` when none is earlier. */
const firstExpenseDay = (db: Database.Database, today: string): string =>
  db
    .prepare<[string], { first: string | null }>(
      `SELECT MIN(occurred_on) AS first FROM expenses
       WHERE status IN ('current', 'pending') AND occurred_on <= ?`,
    )
    .get(today)?.first ?? today;

/** AC2-AC5: every figure of the answer, from the rows of the period and filters. */
const compute = (
  db: Database.Database,
  {
    from,
    to,
    categoryId,
    merchantIds,
  }: {
    from: string;
    to: string;
    categoryId: number | null;
    merchantIds: number[] | null;
  },
): Omit<ExpenseQueryAnswer, 'from' | 'to' | 'today' | 'category' | 'merchant'> => {
  const conditions = ['e.occurred_on BETWEEN ? AND ?'];
  const params: (string | number)[] = [from, to];
  if (categoryId !== null) {
    conditions.push('e.category_id = ?');
    params.push(categoryId);
  }
  if (merchantIds !== null) {
    conditions.push(`e.merchant_id IN (${merchantIds.map(() => '?').join(', ') || 'NULL'})`);
    params.push(...merchantIds);
  }
  const where = conditions.join(' AND ');
  // DK-25: every sum is kept per currency, never added across currencies.
  const totals = db
    .prepare<unknown[], Money & { count: number }>(
      `SELECT e.currency AS currency, SUM(e.total_cents) AS cents, COUNT(*) AS count
       FROM expenses e WHERE e.status = 'current' AND ${where}
       GROUP BY e.currency`,
    )
    .all(...params);
  const total = sumByCurrency(totals);
  const order = total.map(({ currency }) => currency);
  const pending =
    db
      .prepare<unknown[], { count: number }>(
        `SELECT COUNT(*) AS count FROM expenses e WHERE e.status = 'pending' AND ${where}`,
      )
      .get(...params)?.count ?? 0;
  // AC3: by category, `Sin clasificar` last; within a category, its top merchants and then the
  // rest (other merchants and expenses with none) as one amount, so the breakdown sums the total.
  const breakdown: Spent[] =
    categoryId === null
      ? spentBy(
          db
            .prepare<unknown[], SpentRow>(
              `SELECT e.category_id AS key, c.name AS name, e.currency AS currency,
                 SUM(e.total_cents) AS cents FROM expenses e
               LEFT JOIN categories c ON c.id = e.category_id
               WHERE e.status = 'current' AND ${where}
               GROUP BY e.category_id, e.currency`,
            )
            .all(...params),
          order,
        )
      : spentBy(
          db
            .prepare<unknown[], SpentRow>(
              `SELECT e.merchant_id AS key, m.name AS name, e.currency AS currency,
                 SUM(e.total_cents) AS cents FROM expenses e
               JOIN entities m ON m.id = e.merchant_id
               WHERE e.status = 'current' AND ${where}
               GROUP BY e.merchant_id, e.currency`,
            )
            .all(...params),
          order,
        ).slice(0, TOP_MERCHANTS);
  return {
    total,
    count: totals.reduce((sum, { count }) => sum + count, 0),
    breakdown,
    others: subtractByCurrency(
      total,
      breakdown.flatMap(({ cents }) => cents),
    ),
    pending,
  };
};

/** The last day of month `month` (1 to 12) of `year`, `YYYY-MM-DD`. */
const lastDayOf = (year: number, month: number): string =>
  new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

/**
 * B78 (assumption): a month named without a year is the latest one that is not in the future,
 * so "en diciembre" asked in January is last December. When the processor answers a whole
 * calendar month that starts after today and the principal did not write its year, it is moved
 * to that latest one; any other period is left as the processor gave it.
 */
const latestMonth = (call: ExpenseQueryCall, text: string, today: string): ExpenseQueryCall => {
  const { from, to } = call;
  if (from === null || from <= today || !from.endsWith('-01')) return call;
  const [year, month] = from.split('-').map(Number) as [number, number];
  if (to !== lastDayOf(year, month) || text.includes(String(year))) return call;
  const [thisYear, thisMonth] = today.split('-').map(Number) as [number, number];
  const latest = month <= thisMonth ? thisYear : thisYear - 1;
  return { ...call, from: `${latest}-${from.slice(5, 7)}-01`, to: lastDayOf(latest, month) };
};

/** AC7: a call code cannot answer is handled as R-22 AC1; the log names only the reason. */
const unusable = (reason: string, channelRef: string, env: CapabilityEnv): Reply => {
  env.logger.warn('expense query not answered', { channelRef, reason });
  return { text: strings.processingFailed() };
};

const answer = (
  asked: ExpenseQueryCall,
  message: { text: string; channelRef: string },
  env: CapabilityEnv,
): Reply => {
  const today = todayIn(env.timeZone, env.now());
  const call = latestMonth(asked, message.text, today);
  // AC7: a period that starts after today is not a query on what was spent.
  const from = call.from ?? firstExpenseDay(env.db, today);
  if (from > today) return unusable('period in the future', message.channelRef, env);
  // AC1: a period the processor ends after today ends today. The dates are strings, so
  // `Math.min` does not apply.
  // biome-ignore lint/complexity/useMathMinMax: comparing `YYYY-MM-DD` strings
  const to = call.to > today ? today : call.to;
  const category = call.category?.toLowerCase() ?? null;
  const categoryId = categoryIdOf(env.db, category);
  if (category !== null && categoryId === null) {
    return unusable('unknown category', message.channelRef, env);
  }
  const merchant = call.merchant ?? null;
  if (merchant !== null && !quotedFrom(foldCareful(merchant), foldCareful(message.text))) {
    return unusable('merchant not quoted from the message', message.channelRef, env);
  }
  const figures = compute(env.db, {
    from,
    to,
    categoryId,
    merchantIds: merchant === null ? null : merchantsMatching(env.db, merchant),
  });
  return { text: strings.expenseQuery({ from, to, today, category, merchant, ...figures }) };
};

export const expenseQueryCapability = defineCapability({
  name: 'expense-query',
  kinds: ['expense_query'],
  prompt: PROMPT,
  schema: callSchema,
  handle: async (call, message, env) => answer(call, message, env),
});
