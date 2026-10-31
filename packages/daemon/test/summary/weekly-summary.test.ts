import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Reply } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { createWeeklySummary } from '../../src/summary/weekly-summary.ts';

// R-10: the weekly summary covers the 7 days that end on the day it is sent, in TZ, and S-9 goes
// out verbatim with figures computed in code from the expenses table.
const TZ = 'Europe/Madrid';
// Sunday 1 November 2026 at 20:00 in Madrid: the week is Monday 26 October to Sunday 1 November.
const SENT_AT = new Date('2026-11-01T19:00:00.000Z');

let scratch: string;
let db: Database.Database;
let sent: Reply[];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-summary-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
  sent = [];
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const addCategory = (name: string) =>
  db
    .prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
    .run(name, SENT_AT.toISOString());

const addExpense = (
  occurredOn: string,
  cents: number,
  category: string | null,
  status: 'current' | 'pending' | 'refuted' = 'current',
) =>
  db
    .prepare(
      `INSERT INTO expenses (occurred_on, total_cents, category_id, mode, status, created_at)
       VALUES (?, ?, (SELECT id FROM categories WHERE name = ?), 'declared', ?, ?)`,
    )
    .run(occurredOn, cents, category, status, SENT_AT.toISOString());

const sendSummary = async () => {
  await createWeeklySummary({
    db,
    timeZone: TZ,
    now: () => SENT_AT,
    notify: async (reply) => {
      sent.push(reply);
    },
  }).send();
  expect(sent).toHaveLength(1);
  return sent[0];
};

describe('R-10 weekly summary', () => {
  it('AC3, AC4: S-9 lists every category high to low, at 0,00 € when empty, Sin clasificar last', async () => {
    addCategory('gasolina');
    addCategory('ocio');
    addExpense('2026-10-26', 3000, 'supermercado');
    addExpense('2026-11-01', 1520, 'supermercado');
    addExpense('2026-10-30', 2300, 'gasolina');
    addExpense('2026-10-28', 6000, null);

    const reply = await sendSummary();

    // Ties (ocio, restaurantes at 0,00 €) are ordered by name.
    expect(reply).toEqual({
      text: 'Semana del 26 de octubre al 1 de noviembre: 128,20 €. Supermercado 45,20 € · Gasolina 23,00 € · Ocio 0,00 € · Restaurantes 0,00 € · Sin clasificar 60,00 €. Pendientes de confirmar: 0.',
    });
  });

  it('AC2: {pendientes} counts every pending expense, whatever its week', async () => {
    addExpense('2026-11-01', 1000, 'supermercado', 'pending');
    addExpense('2026-09-15', 2000, null, 'pending');

    const reply = await sendSummary();

    expect(reply?.text).toBe(
      'Semana del 26 de octubre al 1 de noviembre: 0,00 €. Restaurantes 0,00 € · Supermercado 0,00 € · Sin clasificar 0,00 €. Pendientes de confirmar: 2.',
    );
  });

  it('AC3: counts only current expenses whose day falls within the 7 days', async () => {
    addExpense('2026-10-26', 1000, 'restaurantes');
    addExpense('2026-10-25', 4000, 'restaurantes');
    addExpense('2026-10-29', 5000, 'restaurantes', 'refuted');
    addExpense('2026-11-02', 6000, 'restaurantes');

    const reply = await sendSummary();

    expect(reply?.text).toBe(
      'Semana del 26 de octubre al 1 de noviembre: 10,00 €. Restaurantes 10,00 € · Supermercado 0,00 € · Sin clasificar 0,00 €. Pendientes de confirmar: 0.',
    );
  });
});
