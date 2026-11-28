// R-7 AC7 and B87: the recent expenses a typed correction may point at, each with its own
// currency (DK-25), so the processor can tell a stored euro expense from a dollar one.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECENT_EXPENSE_LIMIT, recentExpenses } from '../../src/store/amend-expense.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { registerTextExpense } from '../../src/store/expenses.ts';

let scratch: string;
let db: Database.Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-recent-expenses-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
});
afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const typed = (total_cents: number, currency: string, now: string) =>
  registerTextExpense(db, {
    total_cents,
    currency,
    merchant: null,
    occurred_on: now.slice(0, 10),
    category: null,
    category_basis: null,
    authorized_by: 'principal',
    channelRef: `telegram:1:${now}`,
    receivedAt: now,
    declaredCategory: null,
    inferences: [],
    processorSource: 'test',
    now,
  }).expenseId;

const at = (minute: number) => `2026-11-20T18:${String(minute).padStart(2, '0')}:00.000Z`;

describe('recentExpenses', () => {
  it('B87: gives each expense its total in its own currency, whatever the principal has now', () => {
    const eur = typed(1200, 'EUR', at(1));
    const usd = typed(1200, 'USD', at(2));

    expect(recentExpenses(db, at(0))).toEqual([
      {
        id: usd,
        total: { cents: 1200, currency: 'USD' },
        merchant: null,
        category: null,
        occurred_on: '2026-11-20',
      },
      {
        id: eur,
        total: { cents: 1200, currency: 'EUR' },
        merchant: null,
        category: null,
        occurred_on: '2026-11-20',
      },
    ]);
  });

  it('R-7 AC7: keeps only current expenses since the given time, newest first, at most five', () => {
    const oldest = typed(100, 'EUR', at(1));
    const ids = [2, 3, 4, 5, 6].map((minute) => typed(minute * 100, 'EUR', at(minute)));
    const refuted = typed(700, 'EUR', at(7));
    db.prepare("UPDATE expenses SET status = 'refuted' WHERE id = ?").run(refuted);
    const newestFirst = (list: number[]) => [...list].reverse();

    // Six current ones since minute 1: the newest five, so the oldest is left out by the limit.
    expect(RECENT_EXPENSE_LIMIT).toBe(5);
    expect(recentExpenses(db, at(1)).map(({ id }) => id)).toEqual(newestFirst(ids));
    expect(recentExpenses(db, at(1)).map(({ id }) => id)).not.toContain(oldest);
    // Since minute 3: only those registered at or after it.
    expect(recentExpenses(db, at(3)).map(({ id }) => id)).toEqual(newestFirst(ids.slice(1)));
    expect(recentExpenses(db, at(8))).toEqual([]);
  });

  it('B87: expenses registered at the same time come newest id first, each in its own currency', () => {
    const usd = typed(200, 'USD', at(2));
    const gbp = typed(300, 'GBP', at(2));
    const jpy = typed(500, 'JPY', at(3));

    expect(recentExpenses(db, at(0)).map(({ id, total }) => ({ id, total }))).toEqual([
      { id: jpy, total: { cents: 500, currency: 'JPY' } },
      { id: gbp, total: { cents: 300, currency: 'GBP' } },
      { id: usd, total: { cents: 200, currency: 'USD' } },
    ]);
  });
});
