// Regression probes from the B63 verifier: R-17 AC6 closes a Gastos row's own question (DK-17 AC6)
// and reopens every other one, at the boundary, from a row press and from the retention job.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strings } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createButtonHandler } from '../../src/decisions/answer.ts';
import { rowButton } from '../../src/decisions/window-amend.ts';
import { createRetention } from '../../src/retention/retention-job.ts';
import { openAmendExpenseDecision } from '../../src/store/amend-expense.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { awaitText, reopenStaleAwaiting } from '../../src/store/decisions.ts';
import { recordDecisionMessage } from '../../src/store/receipts.ts';

const T0 = '2026-11-20T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms);
const MIN = 60_000;
let scratch: string;
let db: Database.Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-stale-row-question-'));
  db = openDatabase(join(scratch, 'a.db'));
  applyMigrations(db);
});
afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const expense = (): number =>
  Number(
    db
      .prepare(
        `INSERT INTO expenses (occurred_on, total_cents, mode, status, created_at)
         VALUES ('2026-11-01', 1230, 'declared', 'current', ?)`,
      )
      .run(T0).lastInsertRowid,
  );
const ask = (expenseId: number, rule?: string) =>
  openAmendExpenseDecision(db, {
    expenseId,
    source: 'x',
    question: 'q',
    options: ['Deshacer', 'Corregir'],
    now: T0,
    ...(rule === undefined ? {} : { rule }),
  });
const pair = (id: number) =>
  db
    .prepare(
      `SELECT d.status AS d, d.awaiting_since AS since, p.status AS p FROM pending_decisions d
       JOIN proposals p ON p.id = d.proposal_id WHERE d.id = ?`,
    )
    .get(id);

describe('B63: a stale row question (reopenStaleAwaiting)', () => {
  it('closes a stale row question (expired/rejected), reopens a stale R-7 AC4 one even without channel_ref', () => {
    const e = expense();
    const row = ask(e, 'DK-17 AC6');
    const e2 = expense();
    const reply = ask(e2); // R-7 AC4, delivery never recorded
    awaitText(db, reply, T0);
    awaitText(db, row, T0); // moves `reply` back to open (R-17 AC3)
    expect(pair(reply)).toMatchObject({ d: 'open', p: 'asked' });
    awaitText(db, reply, T0);
    expect(pair(row)).toMatchObject({ d: 'open', p: 'asked' });
    awaitText(db, row, T0);
    expect(reopenStaleAwaiting(db, at(15 * MIN - 1))).toBe(0);
    expect(pair(row)).toMatchObject({ d: 'awaiting_text', p: 'asked' });
    // boundary: exactly 15 minutes counts, as before
    expect(reopenStaleAwaiting(db, at(15 * MIN))).toBe(1);
    expect(pair(row)).toEqual({ d: 'expired', since: null, p: 'rejected' });
    expect(reopenStaleAwaiting(db, at(16 * MIN))).toBe(0);
  });

  it('a stale R-7 AC4 question goes back to open, proposal asked', () => {
    const reply = ask(expense());
    awaitText(db, reply, T0);
    expect(reopenStaleAwaiting(db, at(16 * MIN))).toBe(1);
    expect(pair(reply)).toEqual({ d: 'open', since: null, p: 'asked' });
  });

  it('a DK-17 AC6 question whose message was recorded is reopened, not closed', () => {
    const row = ask(expense(), 'DK-17 AC6');
    recordDecisionMessage(db, row, 'telegram:1');
    awaitText(db, row, T0);
    reopenStaleAwaiting(db, at(16 * MIN));
    expect(pair(row)).toMatchObject({ d: 'open', p: 'asked' });
  });

  it('another operation with the same basis rule is reopened', () => {
    const p = Number(
      db
        .prepare(
          `INSERT INTO proposals (matter_id, operation, payload_json, basis_json, status, created_at)
           VALUES ((SELECT id FROM matters LIMIT 1), 'create_policy', '{}', '{"rule":"DK-17 AC6"}', 'asked', ?)`,
        )
        .run(T0).lastInsertRowid,
    );
    const d = Number(
      db
        .prepare(
          `INSERT INTO pending_decisions (proposal_id, question, options_json, status, created_at)
           VALUES (?, 'q', '["Sí","No"]', 'open', ?)`,
        )
        .run(p, T0).lastInsertRowid,
    );
    awaitText(db, d, T0);
    reopenStaleAwaiting(db, at(16 * MIN));
    expect(pair(d)).toMatchObject({ d: 'open', p: 'asked' });
  });
});

describe('B63: a row press after the 15 minutes (rowButton)', () => {
  it('Corregir and Deshacer both get a fresh question; the old data gets S-19', async () => {
    const e = expense();
    const first = rowButton(db, { expenseId: e, option: 'correct', now: T0 });
    const firstId = Number(first?.split(':')[1]);
    awaitText(db, firstId, T0);
    // under 15 minutes the same question is pressed again
    expect(
      rowButton(db, { expenseId: e, option: 'correct', now: at(14 * MIN).toISOString() }),
    ).toBe(first);
    const undo = rowButton(db, { expenseId: e, option: 'undo', now: at(16 * MIN).toISOString() });
    expect(undo).not.toBeNull();
    expect(Number(undo?.split(':')[1])).not.toBe(firstId);
    expect(undo?.endsWith(':0')).toBe(true);
    expect(pair(firstId)).toEqual({ d: 'expired', since: null, p: 'rejected' });
    const handler = createButtonHandler({
      db,
      answers: {},
      now: () => at(17 * MIN),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(
      await handler({ data: first ?? '', channelRef: 'desktop:gastos', pressedAt: T0 }),
    ).toEqual({
      text: strings.decisionClosed(),
    });
  });

  it('an R-7 AC4 question left stale is reopened and pressed again by the row', () => {
    const e = expense();
    const reply = ask(e);
    awaitText(db, reply, T0);
    expect(rowButton(db, { expenseId: e, option: 'undo', now: at(16 * MIN).toISOString() })).toBe(
      `decision:${reply}:0`,
    );
    expect(pair(reply)).toMatchObject({ d: 'open', p: 'asked' });
  });
});

describe('B63: the retention job and a stale row question', () => {
  it('a stale row question is closed once; later retention runs leave it', async () => {
    const row = ask(expense(), 'DK-17 AC6');
    awaitText(db, row, T0);
    let clock = at(16 * MIN);
    const job = createRetention({
      db,
      inboxDir: join(scratch, 'inbox'),
      timeZone: 'Europe/Madrid',
      now: () => clock,
      notify: async () => {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await job.retain();
    expect(pair(row)).toEqual({ d: 'expired', since: null, p: 'rejected' });
    clock = at(8 * 86_400_000);
    await job.retain();
    expect(pair(row)).toEqual({ d: 'expired', since: null, p: 'rejected' });
  });
});
