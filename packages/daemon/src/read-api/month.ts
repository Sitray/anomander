import { todayIn } from '@anomander/core';
import {
  type CategoryMode,
  type ChatExpense,
  type ChatExpenses,
  type ExpenseMode,
  getCurrency,
  type Money,
  sumByCurrency,
} from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { readGastos, readLineas, readPendientes } from './queries.ts';

// DK-17 (docs/desktop-prd.md): the expenses of one month for the window's "Gastos" screen,
// through the same queries as the read API (RA-2 AC6). The views give one mode and one currency
// (DK-25, B71) per expense; how its category was chosen is read beside them, from `expenses`,
// since this is the daemon's own window and not an outside reader (read access §4).

/** What the local channel answers to an `expenses` request, without the request's id. */
export type ExpensesMonth = Omit<ChatExpenses, 'type' | 'inReplyTo'>;

/** Sums per currency (DK-25); nothing is zero in the principal's currency. */
const perCurrency = (amounts: readonly Money[]): Money[] => {
  const sums = sumByCurrency(amounts);
  return sums.length === 0 ? [{ cents: 0, currency: getCurrency() }] : sums;
};

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
  const beside = new Map(
    db
      .prepare<[string, string], { id: number; category_basis: CategoryMode | null }>(
        `SELECT id, category_basis FROM expenses
         WHERE status = 'current' AND occurred_on BETWEEN ? AND ?`,
      )
      .all(range.desde, range.hasta)
      .map((row) => [row.id, row]),
  );
  const expenses = readGastos(db, range).map(
    (gasto): ChatExpense => ({
      id: gasto.id,
      date: gasto.fecha,
      merchant: gasto.comercio,
      category: gasto.categoria,
      totalCents: gasto.total_cents,
      currency: gasto.moneda,
      // The view's CHECK on `expenses.mode` allows only these.
      mode: gasto.modo as ExpenseMode,
      // A basis left from a category since removed says nothing about this row.
      categoryMode:
        gasto.categoria === null ? null : (beside.get(gasto.id)?.category_basis ?? null),
      origin: gasto.origen === 'ticket' ? 'receipt' : 'text',
      lines: lines.get(gasto.id) ?? 0,
    }),
  );
  // B71: `pendientes_de_confirmar` keeps one total per currency, never one across them.
  const pending = readPendientes(db);
  return {
    month: asked,
    expenses,
    totals: perCurrency(
      expenses.map(({ totalCents, currency }) => ({ cents: totalCents, currency })),
    ),
    pending: {
      count: pending.cantidad,
      totals: perCurrency(
        pending.por_moneda.map(({ moneda, total_cents }) => ({
          cents: total_cents,
          currency: moneda,
        })),
      ),
    },
  };
};
