// B79 (R-7 AC9): what a correction's "Deshacer" checks before it puts values back, read from the
// payload as the button handler reads it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  amendExpense,
  correctionStands,
  openCorrectionUndoDecision,
  restoreOf,
  undoCorrection,
} from '../../src/store/amend-expense.ts';
import { assignDeclaredCategory } from '../../src/store/categories.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { loadDecision } from '../../src/store/decisions.ts';
import { categoryIdOf, registerTextExpense } from '../../src/store/expenses.ts';

const NOW = '2026-11-20T18:30:00.000Z';
let scratch: string;
let db: Database.Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-undo-guard-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
});
afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const typed = (
  over: { merchant?: string | null; category?: string | null; declared?: string | null } = {},
) =>
  registerTextExpense(db, {
    total_cents: 2300,
    currency: 'EUR',
    merchant: over.merchant ?? null,
    occurred_on: '2026-11-19',
    category: over.category ?? null,
    category_basis: over.category ? 'declared' : null,
    authorized_by: 'principal',
    channelRef: 'telegram:1:1',
    receivedAt: NOW,
    declaredCategory: over.declared ?? null,
    inferences: [],
    processorSource: 'test',
    now: NOW,
  }).expenseId;

/** Through the stored payload and its zod schema, as the button handler reads it. */
const stored = (expenseId: number, restore: unknown) => {
  const decisionId = openCorrectionUndoDecision(db, {
    expenseId,
    restore: restore as never,
    source: 'telegram:1:2',
    question: 'Corregido',
    options: ['Deshacer'],
    now: NOW,
  });
  const decision = loadDecision(db, decisionId);
  if (decision === null) throw new Error('no decision');
  const parsed = restoreOf({ ...decision, status: 'open' } as never);
  if (parsed === null || parsed === 'unreadable') throw new Error(`restore ${String(parsed)}`);
  return { parsed, proposalId: decision.proposal_id };
};

const row = (id: number) =>
  db
    .prepare(
      'SELECT total_cents, merchant_id, category_id, category_basis, occurred_on, mode FROM expenses WHERE id = ?',
    )
    .get(id);

describe('the undo guard of a correction, through its stored payload (R-7 AC9, B79)', () => {
  it('a merchant + category + date correction of an expense with NULL merchant/category still undoes', () => {
    const id = typed();
    const before = row(id);
    const { restore } = db.transaction(() =>
      amendExpense(db, {
        expenseId: id,
        proposalId: null,
        correction: {
          merchant: 'Bar Pepe',
          category: 'restaurantes',
          occurred_on: '2026-11-18',
          total_cents: 1999,
        },
        source: 'telegram:1:2',
        receivedAt: NOW,
        now: NOW,
      }),
    )();
    const { parsed, proposalId } = stored(id, restore);
    expect(parsed.after).toBeDefined();
    expect(correctionStands(db, id, parsed)).toBe(true);
    db.transaction(() =>
      undoCorrection(db, { expenseId: id, proposalId, restore: parsed, now: NOW }),
    )();
    expect(row(id)).toEqual(before);
  });

  it('a total correction, then S-15 assigning the declared category, still undoes the total only', () => {
    const id = typed({ declared: 'mascotas' });
    const { restore } = db.transaction(() =>
      amendExpense(db, {
        expenseId: id,
        proposalId: null,
        correction: { total_cents: 1999 },
        source: 'telegram:1:2',
        receivedAt: NOW,
        now: NOW,
      }),
    )();
    const { parsed, proposalId } = stored(id, restore);
    db.prepare("INSERT INTO categories (name, created_at) VALUES ('mascotas', ?)").run(NOW);
    expect(assignDeclaredCategory(db, id, categoryIdOf(db, 'mascotas') as number)).toBe(true);
    expect(correctionStands(db, id, parsed)).toBe(true);
    db.transaction(() =>
      undoCorrection(db, { expenseId: id, proposalId, restore: parsed, now: NOW }),
    )();
    expect(row(id)).toMatchObject({ total_cents: 2300, category_basis: 'declared' });
  });

  it('a later change to a restored column refuses (stale undo never overwrites)', () => {
    const id = typed({ category: 'restaurantes' });
    const { restore } = db.transaction(() =>
      amendExpense(db, {
        expenseId: id,
        proposalId: null,
        correction: { category: 'supermercado' },
        source: 'telegram:1:2',
        receivedAt: NOW,
        now: NOW,
      }),
    )();
    const { parsed, proposalId } = stored(id, restore);
    db.prepare("UPDATE expenses SET category_basis = 'policy' WHERE id = ?").run(id);
    expect(correctionStands(db, id, parsed)).toBe(false);
    expect(() =>
      db.transaction(() =>
        undoCorrection(db, { expenseId: id, proposalId, restore: parsed, now: NOW }),
      )(),
    ).toThrow(/no longer stands/);
  });

  it('a payload with no `after` (stored before B79) still parses and undoes', () => {
    const id = typed();
    const { restore } = db.transaction(() =>
      amendExpense(db, {
        expenseId: id,
        proposalId: null,
        correction: { total_cents: 1999 },
        source: 'telegram:1:2',
        receivedAt: NOW,
        now: NOW,
      }),
    )();
    const { after: _ignored, ...old } = restore;
    const { parsed } = stored(id, old);
    expect(parsed.after).toBeUndefined();
    expect(correctionStands(db, id, parsed)).toBe(true);
  });
});
