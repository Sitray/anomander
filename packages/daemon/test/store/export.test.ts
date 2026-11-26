import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { exportLedger, InMemoryStoreError } from '../../src/store/export.ts';

// B5: the principal's ledger, the read views of RA-1, as one CSV file per view and one JSON file,
// in a dated folder under `<data folder>/exports/`, readable by the owner only (§16).
const NOW = new Date('2026-11-24T10:30:00.000Z');

let scratch: string;
let db: Database.Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-export-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** An expense with its merchant and purchase lines, as a read receipt leaves it. */
const expense = (
  merchant: string,
  totalCents: number,
  status: 'current' | 'pending' | 'refuted',
  lines: [string, number, number][] = [],
  currency = 'EUR',
): number => {
  const merchantId = Number(
    db
      .prepare("INSERT INTO entities (kind, name, created_at) VALUES ('merchant', ?, ?)")
      .run(merchant, NOW.toISOString()).lastInsertRowid,
  );
  const id = Number(
    db
      .prepare(
        `INSERT INTO expenses (merchant_id, occurred_on, total_cents, currency, category_id, mode,
           status, created_at)
         VALUES (?, '2026-11-23', ?, ?, (SELECT id FROM categories WHERE name = 'supermercado'),
                 'declared', ?, ?)`,
      )
      .run(merchantId, totalCents, currency, status, NOW.toISOString()).lastInsertRowid,
  );
  for (const [name, quantity, amount] of lines) {
    db.prepare(
      'INSERT INTO purchase_lines (expense_id, product_name, quantity, amount_cents) VALUES (?, ?, ?, ?)',
    ).run(id, name, quantity, amount);
  }
  return id;
};

describe('the ledger export', () => {
  it('writes gastos, lineas_de_compra and pendientes_de_confirmar as CSV and JSON, owner only', () => {
    const kept = expense('Mercadona', 1250, 'current', [['Leche, entera', 2, 250]]);
    expense('Lidl', 900, 'pending');
    expense('Old', 100, 'refuted', [['Gone', 1, 100]]);

    const exported = exportLedger(db, scratch, NOW);

    const folder = join(scratch, 'exports', '20261124T103000Z');
    expect(exported.folder).toBe(folder);
    expect(readdirSync(folder).sort()).toEqual([
      'gastos.csv',
      'ledger.json',
      'lineas_de_compra.csv',
      'pendientes_de_confirmar.csv',
    ]);
    expect(exported.files.map((file) => file.slice(folder.length + 1)).sort()).toEqual(
      readdirSync(folder).sort(),
    );
    expect(statSync(join(scratch, 'exports')).mode & 0o777).toBe(0o700);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    for (const file of exported.files) expect(statSync(file).mode & 0o777).toBe(0o600);

    const csv = (name: string) => readFileSync(join(folder, name), 'utf8');
    expect(csv('gastos.csv')).toBe(
      'id,fecha,comercio,categoria,total_cents,modo,origen,moneda\r\n' +
        `${kept},2026-11-23,Mercadona,supermercado,1250,declared,texto,EUR\r\n`,
    );
    expect(csv('lineas_de_compra.csv')).toBe(
      'gasto_id,producto,cantidad,precio_cents,comercio,categoria,fecha,modo,moneda\r\n' +
        `${kept},"Leche, entera",2,250,Mercadona,supermercado,2026-11-23,declared,EUR\r\n`,
    );
    expect(csv('pendientes_de_confirmar.csv')).toBe(
      'cantidad,total_cents,moneda,por_moneda\r\n' +
        '1,900,EUR,"[{""moneda"":""EUR"",""cantidad"":1,""total_cents"":900}]"\r\n',
    );
    expect(JSON.parse(csv('ledger.json'))).toEqual({
      exported_at: '2026-11-24T10:30:00.000Z',
      gastos: [
        {
          id: kept,
          fecha: '2026-11-23',
          comercio: 'Mercadona',
          categoria: 'supermercado',
          total_cents: 1250,
          modo: 'declared',
          origen: 'texto',
          moneda: 'EUR',
        },
      ],
      lineas_de_compra: [
        {
          gasto_id: kept,
          producto: 'Leche, entera',
          cantidad: 2,
          precio_cents: 250,
          comercio: 'Mercadona',
          categoria: 'supermercado',
          fecha: '2026-11-23',
          modo: 'declared',
          moneda: 'EUR',
        },
      ],
      pendientes_de_confirmar: {
        cantidad: 1,
        total_cents: 900,
        moneda: 'EUR',
        por_moneda: [{ moneda: 'EUR', cantidad: 1, total_cents: 900 }],
      },
    });
  });

  it('B71: says the currency of every row and never adds pending ones of two currencies', () => {
    const eur = expense('Mercadona', 1250, 'current');
    const usd = expense('Target', 1200, 'current', [['Milk', 1, 1200]], 'USD');
    expense('Lidl', 900, 'pending');
    expense('Walmart', 300, 'pending', [], 'USD');

    const { folder } = exportLedger(db, scratch, NOW);

    const csv = (name: string) => readFileSync(join(folder, name), 'utf8');
    expect(csv('gastos.csv')).toContain(
      `${eur},2026-11-23,Mercadona,supermercado,1250,declared,texto,EUR\r\n`,
    );
    expect(csv('gastos.csv')).toContain(
      `${usd},2026-11-23,Target,supermercado,1200,declared,texto,USD\r\n`,
    );
    expect(csv('lineas_de_compra.csv')).toContain(',declared,USD\r\n');
    expect(csv('pendientes_de_confirmar.csv')).toBe(
      'cantidad,total_cents,moneda,por_moneda\r\n' +
        '2,,,"[{""moneda"":""EUR"",""cantidad"":1,""total_cents"":900},' +
        '{""moneda"":""USD"",""cantidad"":1,""total_cents"":300}]"\r\n',
    );
    const ledger = JSON.parse(csv('ledger.json'));
    expect(ledger.gastos.map((gasto: { moneda: string }) => gasto.moneda)).toEqual(['EUR', 'USD']);
    expect(ledger.pendientes_de_confirmar).toEqual({
      cantidad: 2,
      total_cents: null,
      moneda: null,
      por_moneda: [
        { moneda: 'EUR', cantidad: 1, total_cents: 900 },
        { moneda: 'USD', cantidad: 1, total_cents: 300 },
      ],
    });
  });

  it('quotes CSV fields and keeps a spreadsheet from reading a text as a formula', () => {
    expense('=HYPERLINK("x")', 500, 'current', [['say "hi"\nthere', 1, 500]]);

    const { folder } = exportLedger(db, scratch, NOW);

    const gastos = readFileSync(join(folder, 'gastos.csv'), 'utf8');
    expect(gastos).toContain(',"\'=HYPERLINK(""x"")",');
    const lines = readFileSync(join(folder, 'lineas_de_compra.csv'), 'utf8');
    expect(lines).toContain(',"say ""hi""\nthere",');
    // The JSON file keeps the text as stored.
    const json = JSON.parse(readFileSync(join(folder, 'ledger.json'), 'utf8'));
    expect(json.gastos[0].comercio).toBe('=HYPERLINK("x")');
  });

  it('never overwrites an export made the same second', () => {
    const first = exportLedger(db, scratch, NOW);
    const second = exportLedger(db, scratch, NOW);

    expect(second.folder).not.toBe(first.folder);
    expect(readdirSync(join(scratch, 'exports')).sort()).toEqual([
      '20261124T103000Z',
      '20261124T103000Z-1',
    ]);
  });

  it('B52: refuses an in-memory store, which has no data folder, and writes nothing', () => {
    const memory = openDatabase(':memory:');
    applyMigrations(memory);
    try {
      expect(() => exportLedger(memory, scratch, NOW)).toThrow(InMemoryStoreError);
      expect(readdirSync(scratch)).not.toContain('exports');
    } finally {
      memory.close();
    }
  });
});
