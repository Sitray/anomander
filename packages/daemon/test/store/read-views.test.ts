import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { registerTextExpense } from '../../src/store/expenses.ts';

// RA-1 (docs/read-access-prd.md): the views other applications read, over a migrated SQLite file.
const NOW = '2026-11-10T10:00:00.000Z';

let scratch: string;
let db: Database.Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-views-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const rows = (view: string): unknown[] => db.prepare(`SELECT * FROM ${view}`).all();

interface ExpenseRow {
  merchant: string | null;
  category: string | null;
  total_cents: number;
  mode?: string;
  status?: string;
  currency?: string;
  lines?: [string, number, number][];
}

/** A receipt expense as `insertReceiptExpense` leaves it: a document, the expense, its lines. */
const receipt = (expense: ExpenseRow): number => {
  const documentId = Number(
    db
      .prepare(
        `INSERT INTO documents (kind, received_at, source, status)
         VALUES ('receipt', ?, 'telegram:1', 'read')`,
      )
      .run(NOW).lastInsertRowid,
  );
  const merchantId =
    expense.merchant === null
      ? null
      : Number(
          db
            .prepare("INSERT INTO entities (kind, name, created_at) VALUES ('merchant', ?, ?)")
            .run(expense.merchant, NOW).lastInsertRowid,
        );
  const id = Number(
    db
      .prepare(
        `INSERT INTO expenses (merchant_id, occurred_on, total_cents, currency, category_id, mode,
           document_id, status, created_at)
         VALUES (?, '2026-11-09', ?, ?, (SELECT id FROM categories WHERE name = ?), ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        expense.total_cents,
        expense.currency ?? 'EUR',
        expense.category,
        expense.mode ?? 'corroborated',
        documentId,
        expense.status ?? 'current',
        NOW,
      ).lastInsertRowid,
  );
  for (const [name, quantity, amount] of expense.lines ?? []) {
    db.prepare(
      'INSERT INTO purchase_lines (expense_id, product_name, quantity, amount_cents) VALUES (?, ?, ?, ?)',
    ).run(id, name, quantity, amount);
  }
  return id;
};

describe('the read views (RA-1)', () => {
  it('AC1: "23 € cena" is one texto row with no lines; a receipt is ticket with one line per line', () => {
    const { expenseId: cena } = registerTextExpense(db, {
      total_cents: 2300,
      currency: 'EUR',
      merchant: null,
      occurred_on: '2026-11-10',
      category: 'restaurantes',
      category_basis: 'declared',
      authorized_by: 'principal',
      channelRef: 'telegram:7',
      receivedAt: NOW,
      declaredCategory: null,
      inferences: [],
      processorSource: 'processor:openai/gpt-4o-mini',
      now: NOW,
    });
    expect(rows('gastos')).toEqual([
      {
        id: cena,
        fecha: '2026-11-10',
        comercio: null,
        categoria: 'restaurantes',
        total_cents: 2300,
        modo: 'declared',
        origen: 'texto',
        moneda: 'EUR',
      },
    ]);
    expect(rows('lineas_de_compra')).toEqual([]);

    const ticket = receipt({
      merchant: 'Mercadona',
      category: 'supermercado',
      total_cents: 450,
      lines: [
        ['LECHE ENTERA', 2, 190],
        ['PAN', 1, 260],
      ],
    });
    expect(db.prepare('SELECT * FROM gastos WHERE id = ?').get(ticket)).toEqual({
      id: ticket,
      fecha: '2026-11-09',
      comercio: 'Mercadona',
      categoria: 'supermercado',
      total_cents: 450,
      modo: 'corroborated',
      origen: 'ticket',
      moneda: 'EUR',
    });
    const line = {
      gasto_id: ticket,
      comercio: 'Mercadona',
      categoria: 'supermercado',
      fecha: '2026-11-09',
      modo: 'corroborated',
      moneda: 'EUR',
    };
    expect(db.prepare('SELECT * FROM lineas_de_compra ORDER BY producto').all()).toEqual([
      { ...line, producto: 'LECHE ENTERA', cantidad: 2, precio_cents: 190 },
      { ...line, producto: 'PAN', cantidad: 1, precio_cents: 260 },
    ]);
  });

  it('AC2: an expense with no merchant and no category is listed with NULLs, its lines too', () => {
    const id = receipt({
      merchant: null,
      category: null,
      total_cents: 300,
      mode: 'inferred',
      lines: [['CAFE', 1, 300]],
    });
    expect(rows('gastos')).toEqual([
      {
        id,
        fecha: '2026-11-09',
        comercio: null,
        categoria: null,
        total_cents: 300,
        modo: 'inferred',
        origen: 'ticket',
        moneda: 'EUR',
      },
    ]);
    expect(rows('lineas_de_compra')).toEqual([
      {
        gasto_id: id,
        producto: 'CAFE',
        cantidad: 1,
        precio_cents: 300,
        comercio: null,
        categoria: null,
        fecha: '2026-11-09',
        modo: 'inferred',
        moneda: 'EUR',
      },
    ]);
  });

  it('AC3: pending and refuted expenses are in neither view; pending ones are counted apart', () => {
    expect(rows('pendientes_de_confirmar')).toEqual([
      { cantidad: 0, total_cents: 0, moneda: null, por_moneda: '[]' },
    ]);

    const pending = { merchant: 'Lidl', category: 'supermercado', status: 'pending' };
    receipt({ ...pending, total_cents: 1000, lines: [['AGUA', 1, 1000]] });
    receipt({ ...pending, total_cents: 500, lines: [['FRUTA', 1, 500]] });
    receipt({
      merchant: 'Dia',
      category: 'supermercado',
      total_cents: 700,
      status: 'refuted',
      lines: [['ARROZ', 1, 700]],
    });

    expect(rows('gastos')).toEqual([]);
    expect(rows('lineas_de_compra')).toEqual([]);
    // One currency, as every install before DK-25: the same count and total, now with its currency.
    expect(rows('pendientes_de_confirmar')).toEqual([
      {
        cantidad: 2,
        total_cents: 1500,
        moneda: 'EUR',
        por_moneda: JSON.stringify([{ moneda: 'EUR', cantidad: 2, total_cents: 1500 }]),
      },
    ]);
  });

  it('B71: each row says its currency, and pending expenses of two currencies are never added', () => {
    const eur = receipt({
      merchant: 'Lidl',
      category: null,
      total_cents: 900,
      lines: [['PAN', 1, 900]],
    });
    const usd = receipt({
      merchant: 'Target',
      category: null,
      total_cents: 1200,
      currency: 'USD',
      lines: [['MILK', 1, 1200]],
    });
    receipt({ merchant: 'Dia', category: null, total_cents: 1000, status: 'pending' });
    receipt({
      merchant: 'Walmart',
      category: null,
      total_cents: 300,
      status: 'pending',
      currency: 'USD',
    });
    receipt({
      merchant: 'Walmart',
      category: null,
      total_cents: 200,
      status: 'pending',
      currency: 'USD',
    });

    const currencyOf = (view: string, key: string) =>
      Object.fromEntries(
        db
          .prepare<[], Record<string, unknown>>(`SELECT ${key} AS id, moneda FROM ${view}`)
          .all()
          .map(({ id, moneda }) => [id, moneda]),
      );
    expect(currencyOf('gastos', 'id')).toEqual({ [eur]: 'EUR', [usd]: 'USD' });
    expect(currencyOf('lineas_de_compra', 'gasto_id')).toEqual({ [eur]: 'EUR', [usd]: 'USD' });
    expect(rows('pendientes_de_confirmar')).toEqual([
      {
        cantidad: 3,
        total_cents: null,
        moneda: null,
        por_moneda: JSON.stringify([
          { moneda: 'EUR', cantidad: 1, total_cents: 1000 },
          { moneda: 'USD', cantidad: 2, total_cents: 500 },
        ]),
      },
    ]);
  });
});

describe('migration 0010 (B71)', () => {
  it('a database at 0009 with EUR and USD rows gets views that say each currency, its rows unchanged', async () => {
    const { cpSync, mkdirSync, readdirSync } = await import('node:fs');
    const { MIGRATIONS_DIR } = await import('../../src/store/database.ts');
    const upTo9 = join(scratch, 'm9');
    mkdirSync(upTo9);
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name < '0010')) {
      cpSync(join(MIGRATIONS_DIR, file), join(upTo9, file));
    }
    db.close();
    db = openDatabase(join(scratch, 'old.db'));
    expect(applyMigrations(db, upTo9)).toBe(9);
    const eur = receipt({
      merchant: 'Lidl',
      category: null,
      total_cents: 900,
      lines: [['PAN', 1, 900]],
    });
    const usd = receipt({ merchant: 'Target', category: null, total_cents: 1200, currency: 'USD' });
    receipt({ merchant: 'Dia', category: null, total_cents: 1000, status: 'pending' });
    receipt({
      merchant: 'Walmart',
      category: null,
      total_cents: 300,
      status: 'pending',
      currency: 'USD',
    });
    // At 0009 the pending ones of both currencies are added into one total.
    expect(rows('pendientes_de_confirmar')).toEqual([{ cantidad: 2, total_cents: 1300 }]);
    const stored = db.prepare('SELECT * FROM expenses ORDER BY id').all();

    applyMigrations(db);

    expect(db.prepare('SELECT * FROM expenses ORDER BY id').all()).toEqual(stored);
    expect(
      db
        .prepare<[], { id: number; moneda: string }>('SELECT id, moneda FROM gastos ORDER BY id')
        .all(),
    ).toEqual([
      { id: eur, moneda: 'EUR' },
      { id: usd, moneda: 'USD' },
    ]);
    expect(rows('lineas_de_compra')).toMatchObject([{ gasto_id: eur, moneda: 'EUR' }]);
    expect(rows('pendientes_de_confirmar')).toEqual([
      {
        cantidad: 2,
        total_cents: null,
        moneda: null,
        por_moneda: JSON.stringify([
          { moneda: 'EUR', cantidad: 1, total_cents: 1000 },
          { moneda: 'USD', cantidad: 1, total_cents: 300 },
        ]),
      },
    ]);
  });
});
