// B85 (4), R-17 AC2 (decided by the principal on 2026-11-28: "7 días, igual"): a Telegram reply to
// a "Corregido…" whose "Deshacer" was used corrects the expense again (B79) only for the 7 days an
// unused "Deshacer" stays open (R-19 AC2); after them it goes to the processor, as a reply to an
// expired one does. The router's other routes keep working as before.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrincipalText, Reply } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Correction } from '../../src/decisions/correction.ts';
import { createTextRouter } from '../../src/decisions/router.ts';
import { expireOpenDecisions } from '../../src/retention/queued-receipts.ts';
import { openCorrectionUndoDecision } from '../../src/store/amend-expense.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { answerDecision, awaitText } from '../../src/store/decisions.ts';
import { registerTextExpense } from '../../src/store/expenses.ts';
import { recordDecisionMessage } from '../../src/store/receipts.ts';

const T0 = '2026-11-20T10:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(Date.parse(T0) + ms);
const CORRECTED = 'telegram:20';

let scratch: string;
let db: Database.Database;
let clock: Date;
let corrected: Correction[];
let processed: PrincipalText[];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-router-used-undo-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
  clock = new Date(T0);
  corrected = [];
  processed = [];
});
afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** The router over this test's database, with recording correction and processor handlers. */
const route = (message: PrincipalText): Promise<Reply> =>
  createTextRouter({
    db,
    corrections: {
      amend_expense: async (correction) => {
        corrected.push(correction);
        return { text: 'corrected' };
      },
    },
    otherwise: async (text) => {
      processed.push(text);
      return { text: 'processed' };
    },
    now: () => clock,
  })(message);

const reply = (replyTo?: string): PrincipalText => ({
  text: 'es 14',
  channelRef: 'telegram:99',
  receivedAt: clock.toISOString(),
  ...(replyTo === undefined ? {} : { replyTo }),
});

const expense = () =>
  registerTextExpense(db, {
    total_cents: 2300,
    currency: 'EUR',
    merchant: null,
    occurred_on: '2026-11-19',
    category: null,
    category_basis: null,
    authorized_by: 'principal',
    channelRef: 'telegram:10',
    receivedAt: T0,
    declaredCategory: null,
    inferences: [],
    processorSource: 'test',
    now: T0,
  }).expenseId;

/** The "Deshacer" under a "Corregido…" shown in `channelRef`, asked at `T0`. */
const correctionUndo = (expenseId: number, channelRef = CORRECTED) => {
  const id = openCorrectionUndoDecision(db, {
    expenseId,
    restore: { total_cents: 2300 } as never,
    source: channelRef,
    question: 'Corregido',
    options: ['Deshacer'],
    now: T0,
  });
  recordDecisionMessage(db, id, channelRef);
  return id;
};

/** A "Corregido…" whose "Deshacer" was used: its decision `answered`, its expense still current. */
const usedUndo = () => {
  const id = correctionUndo(expense());
  answerDecision(db, id, null);
  return id;
};

describe('a reply to a "Corregido…" whose "Deshacer" was used (B79, B85 (4))', () => {
  it('at 6 days 23 hours it still corrects the expense', async () => {
    const id = usedUndo();
    clock = at(6 * DAY + 23 * HOUR);

    expect(await route(reply(CORRECTED))).toEqual({ text: 'corrected' });

    expect(corrected.map(({ decision }) => decision.id)).toEqual([id]);
    expect(processed).toEqual([]);
  });

  it('at exactly 7 days it still corrects, as an unused one is still open then (R-19 AC2)', async () => {
    const id = usedUndo();
    clock = at(7 * DAY);

    expect(await route(reply(CORRECTED))).toEqual({ text: 'corrected' });
    expect(corrected.map(({ decision }) => decision.id)).toEqual([id]);
  });

  it('after 7 days it corrects nothing and goes to the processor', async () => {
    usedUndo();
    clock = at(7 * DAY + 1);

    expect(await route(reply(CORRECTED))).toEqual({ text: 'processed' });

    expect(corrected).toEqual([]);
    expect(processed.map(({ text }) => text)).toEqual(['es 14']);
  });
});

describe("the router's other routes, as before", () => {
  it('a reply to an unused "Deshacer" expired after 7 days goes to the processor', async () => {
    correctionUndo(expense());
    clock = at(8 * DAY);
    expect(expireOpenDecisions(db, at(DAY).toISOString())).toBe(1);

    expect(await route(reply(CORRECTED))).toEqual({ text: 'processed' });
    expect(corrected).toEqual([]);
  });

  it('a reply to an open "Deshacer" corrects through it', async () => {
    const id = correctionUndo(expense());
    clock = at(DAY);

    expect(await route(reply(CORRECTED))).toEqual({ text: 'corrected' });
    expect(corrected.map(({ decision }) => decision.id)).toEqual([id]);
  });

  it('a text that replies to nothing goes to the decision awaiting text', async () => {
    const id = correctionUndo(expense());
    awaitText(db, id, T0);

    expect(await route(reply())).toEqual({ text: 'corrected' });
    expect(corrected.map(({ decision }) => decision.id)).toEqual([id]);
  });

  it('a reply to a message showing no decision goes to the processor', async () => {
    usedUndo();

    expect(await route(reply('telegram:404'))).toEqual({ text: 'processed' });
    expect(corrected).toEqual([]);
  });
});
