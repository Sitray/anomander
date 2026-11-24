import { todayIn } from '@anomander/core';
import type { CategoryMode, ChatExpense, ChatExpenses, ExpenseMode } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { readGastos, readLineas, readPendientes } from './queries.ts';

// DK-17 (docs/desktop-prd.md): the expenses of one month for the window's "Gastos" screen,
// through the same queries as the read API (RA-2 AC6). The views give one mode per expense; how
// its category was chosen is read beside them, from `expenses.category_basis`, since this is the
// daemon's own window and not an outside reader (read access §4).

/** What the local channel answers to an `expenses` request, without the request's id. */
export type ExpensesMonth = Omit<ChatExpenses, 'type' | 'inReplyTo'>;

/** `YYYY-MM`: a month of the calendar. */
export const isMonth = (value: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

/** The last day of `month`, `YYYY-MM-DD`. */
const lastDay = (month: string): string => {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
};

/**
 * The current expenses of `month` (the current month in `timeZone` when absent), each with its
 * mode and its purchase lines counted, their total summed here, and the pending ones apart.
 */
export const readExpensesMonth = (
  db: Database.Database,
  { month, timeZone, now }: { month: string | undefined; timeZone: string; now: Date },
): ExpensesMonth => {
  const asked = month ?? todayIn(timeZone, now).slice(0, 7);
  const range = { desde: `${asked}-01`, hasta: lastDay(asked) };
  const lines = new Map<number, number>();
  for (const line of readLineas(db, range)) {
    lines.set(line.gasto_id, (lines.get(line.gasto_id) ?? 0) + 1);
  }
  const bases = new Map(
    db
      .prepare<[string, string], { id: number; category_basis: CategoryMode | null }>(
        `SELECT id, category_basis FROM expenses
         WHERE status = 'current' AND occurred_on BETWEEN ? AND ?`,
      )
      .all(range.desde, range.hasta)
      .map((row) => [row.id, row.category_basis]),
  );
  const expenses = readGastos(db, range).map(
    (gasto): ChatExpense => ({
      id: gasto.id,
      date: gasto.fecha,
      merchant: gasto.comercio,
      category: gasto.categoria,
      totalCents: gasto.total_cents,
      // The view's CHECK on `expenses.mode` allows only these.
      mode: gasto.modo as ExpenseMode,
      // A basis left from a category since removed says nothing about this row.
      categoryMode: gasto.categoria === null ? null : (bases.get(gasto.id) ?? null),
      origin: gasto.origen === 'ticket' ? 'receipt' : 'text',
      lines: lines.get(gasto.id) ?? 0,
    }),
  );
  const pending = readPendientes(db);
  return {
    month: asked,
    expenses,
    totalCents: expenses.reduce((sum, expense) => sum + expense.totalCents, 0),
    pending: { count: pending.cantidad, totalCents: pending.total_cents },
  };
};
