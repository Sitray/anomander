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
        `INSERT INTO expenses (merchant_id, occurred_on, total_cents, category_id, mode,
           document_id, status, created_at)
         VALUES (?, '2026-11-09', ?, (SELECT id FROM categories WHERE name = ?), ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        expense.total_cents,
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
    });
    const line = {
      gasto_id: ticket,
      comercio: 'Mercadona',
      categoria: 'supermercado',
      fecha: '2026-11-09',
      modo: 'corroborated',
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
      },
    ]);
  });

  it('AC3: pending and refuted expenses are in neither view; pending ones are counted apart', () => {
    expect(rows('pendientes_de_confirmar')).toEqual([{ cantidad: 0, total_cents: 0 }]);

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
    expect(rows('pendientes_de_confirmar')).toEqual([{ cantidad: 2, total_cents: 1500 }]);
  });
});
