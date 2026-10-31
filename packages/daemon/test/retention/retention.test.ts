import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrincipalReceipt, Reply } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiBudget } from '../../src/budget/ai-budget.ts';
import type { OpenDecision } from '../../src/decisions/types.ts';
import { createReceiptExpenseCycle } from '../../src/expenses/receipt-expense.ts';
import { verbatimReplies } from '../../src/processor/reply-phraser.ts';
import { createKeepReceiptAnswerHandler } from '../../src/retention/keep-receipt-decision.ts';
import { createRetention } from '../../src/retention/retention-job.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { awaitText } from '../../src/store/decisions.ts';
import { insertAssertion, insertProposal } from '../../src/store/expenses.ts';
import { createReceiptDocument, openPendingDecision } from '../../src/store/receipts.ts';

// R-8 AC3 to AC5 and R-19: an unread receipt is kept only as long as allowed, the principal is
// asked before and told after, and the retention job expires what is old, idempotently.
const TZ = 'Europe/Madrid';
const RECEIVED_AT = '2026-10-30T10:00:00.000Z';
const S13 =
  'Todavía no he podido leer el ticket que me enviaste el 30 de octubre. ¿Lo guardo hasta poder leerlo? Si no, lo borro en una hora.';
const S14 = 'He borrado sin leer el ticket que me enviaste el 30 de octubre.';
// The wording of the answers to S-13 is not in §12 yet; the handler takes it from its caller.

let scratch: string;
let inbox: string;
let db: Database.Database;
let clock: Date;
let sent: Reply[];
const now = () => clock;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-retention-'));
  inbox = join(scratch, 'inbox');
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
  clock = new Date(RECEIVED_AT);
  sent = [];
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const retention = () =>
  createRetention({
    db,
    inboxDir: inbox,
    timeZone: TZ,
    now,
    notify: async (reply) => {
      sent.push(reply);
    },
    logger,
  });

/** A receipt received at RECEIVED_AT with the budget exhausted: queued until the next day. */
const queueReceipt = async (): Promise<number> => {
  const cycle = createReceiptExpenseCycle({
    db,
    reader: async () => {
      throw new Error('the reader must not be called');
    },
    budget: createAiBudget({ db, limit: 0, timeZone: TZ, now }),
    inboxDir: inbox,
    timeZone: TZ,
    now,
    processorSource: 'processor:openai/gpt-4o',
    phraser: verbatimReplies,
    logger,
  });
  const receipt: PrincipalReceipt = {
    images: [{ mimeType: 'image/jpeg', load: async () => new Uint8Array([1]) }],
    caption: null,
    channelRef: 'telegram:7',
    receivedAt: RECEIVED_AT,
  };
  await cycle.onReceipt(receipt);
  return 1;
};

const document = (id: number) =>
  db.prepare('SELECT status, keep_until, image_deleted_at FROM documents WHERE id = ?').get(id);

const openDecision = (id: number): OpenDecision => {
  const row = db
    .prepare(
      `SELECT d.id, d.proposal_id, p.operation, p.payload_json, d.options_json, d.status,
              d.channel_ref
       FROM pending_decisions d JOIN proposals p ON p.id = d.proposal_id WHERE d.id = ?`,
    )
    .get(id) as {
    id: number;
    proposal_id: number;
    operation: string;
    payload_json: string;
    options_json: string;
    status: 'open' | 'awaiting_text';
    channel_ref: string | null;
  };
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    operation: row.operation,
    payload: JSON.parse(row.payload_json),
    options: JSON.parse(row.options_json),
    status: row.status,
    channel_ref: row.channel_ref,
  };
};

const decisionState = (id: number) =>
  db
    .prepare(
      `SELECT d.status AS decision, p.status AS proposal, d.answer_assertion_id IS NOT NULL AS answered_by
       FROM pending_decisions d JOIN proposals p ON p.id = d.proposal_id WHERE d.id = ?`,
    )
    .get(id);

describe('R-8 unread receipts', () => {
  it('AC3, AC4: S-13 one hour before keep_until; "Sí" keeps it until 7 days after received_at', async () => {
    const documentId = await queueReceipt();
    const job = retention();

    clock = new Date('2026-10-31T08:59:59.000Z');
    await job.watchQueuedReceipts();
    expect(sent).toEqual([]);

    clock = new Date('2026-10-31T09:00:00.000Z');
    await job.watchQueuedReceipts();
    await job.watchQueuedReceipts();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(S13);
    expect(sent[0]?.buttons).toEqual([
      { label: 'Sí', data: 'decision:1:0' },
      { label: 'No', data: 'decision:1:1' },
    ]);
    sent[0]?.onDelivered?.({ channelRef: 'telegram:99', deliveredAt: clock.toISOString() });
    expect(openDecision(1)).toMatchObject({
      operation: 'keep_receipt',
      payload: { document_id: documentId },
      options: ['Sí', 'No'],
      channel_ref: 'telegram:99',
    });

    const answer = createKeepReceiptAnswerHandler({ timeZone: TZ });
    const reply = await answer({ db, decision: openDecision(1), option: 'Sí', now });

    expect(reply).toEqual({
      text: 'Vale, lo guardo hasta poder leerlo, como mucho hasta el 6 de noviembre.',
    });
    expect(document(documentId)).toEqual({
      status: 'queued',
      keep_until: '2026-11-06T10:00:00.000Z',
      image_deleted_at: null,
    });
    expect(decisionState(1)).toEqual({
      decision: 'answered',
      proposal: 'executed',
      answered_by: 1,
    });
    expect(db.prepare('SELECT authorized_by, status FROM actions').all()).toEqual([
      { authorized_by: 'principal', status: 'executed' },
    ]);

    // The old deadline passes; the receipt is kept and S-13 is not asked again.
    clock = new Date('2026-11-06T09:30:00.000Z');
    await job.retain();
    await job.watchQueuedReceipts();
    expect(sent).toHaveLength(1);
    expect(document(documentId)).toMatchObject({ status: 'queued' });

    // 7 days after received_at is the limit.
    clock = new Date('2026-11-06T10:00:00.000Z');
    await job.watchQueuedReceipts();
    expect(sent.map((reply) => reply.text)).toEqual([S13, S14]);
    expect(document(documentId)).toMatchObject({ status: 'discarded' });
  });

  it('AC4: "No" leaves keep_until as it is', async () => {
    const documentId = await queueReceipt();
    clock = new Date('2026-10-31T09:30:00.000Z');
    await retention().watchQueuedReceipts();

    const answer = createKeepReceiptAnswerHandler({ timeZone: TZ });
    const reply = await answer({ db, decision: openDecision(1), option: 'No', now });

    expect(reply).toEqual({ text: 'Vale, si no consigo leerlo antes, lo borro en una hora.' });
    expect(document(documentId)).toMatchObject({ keep_until: '2026-10-31T10:00:00.000Z' });
    expect(decisionState(1)).toEqual({
      decision: 'answered',
      proposal: 'rejected',
      answered_by: 0,
    });
    expect(db.prepare('SELECT count(*) AS n FROM actions').get()).toEqual({ n: 0 });
  });

  it('AC5: past keep_until unread, the images are deleted, the receipt is discarded and S-14 is sent', async () => {
    const documentId = await queueReceipt();
    const job = retention();
    clock = new Date('2026-10-31T09:30:00.000Z');
    await job.watchQueuedReceipts();

    clock = new Date('2026-10-31T10:00:00.000Z');
    await job.retain();
    await job.retain();

    expect(sent.map((reply) => reply.text)).toEqual([S13, S14]);
    expect(sent[1]?.buttons).toBeUndefined();
    expect(existsSync(join(inbox, String(documentId)))).toBe(false);
    expect(document(documentId)).toEqual({
      status: 'discarded',
      keep_until: '2026-10-31T10:00:00.000Z',
      image_deleted_at: '2026-10-31T10:00:00.000Z',
    });
    // The question about keeping it is closed with the receipt.
    expect(decisionState(1)).toEqual({ decision: 'expired', proposal: 'rejected', answered_by: 0 });
  });
});

describe('R-19 retention job', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(clock.getTime() - days * DAY).toISOString();

  const inference = (subjectType: string, subjectId: number | null, createdAt: string) =>
    insertAssertion(
      db,
      {
        subject_type: subjectType,
        subject_id: subjectId,
        predicate: 'total',
        value_json: 100,
        mode: 'inferred',
        actor: 'processor',
        source: 'processor:openai/gpt-4o',
        basis_json: { quote: '1,00' },
        confidence: 0.9,
        valid_at: null,
        expires_at: null,
        status: 'current',
        supersedes_id: null,
        confirms_id: null,
      },
      createdAt,
    );

  const expense = (status: string, documentId: number | null) =>
    Number(
      db
        .prepare(
          `INSERT INTO expenses (occurred_on, total_cents, mode, document_id, status, created_at)
           VALUES ('2026-09-01', 100, 'inferred', ?, ?, ?)`,
        )
        .run(documentId, status, ago(40)).lastInsertRowid,
    );

  const decision = (documentId: number, createdAt: string) =>
    openPendingDecision(db, {
      proposalId: insertProposal(db, {
        payload: { document_id: documentId },
        basis: {},
        status: 'asked',
        now: createdAt,
      }),
      question: 'S-6',
      options: ['Apuntar', 'Corregir', 'Descartar'],
      now: createdAt,
    });

  type Row = { id: number; status: string };
  const statuses = (table: string) =>
    db.prepare<[], Row>(`SELECT id, status FROM ${table} ORDER BY id`).all();
  const snapshot = () => ({
    assertions: statuses('assertions'),
    decisions: statuses('pending_decisions'),
    proposals: statuses('proposals'),
    expenses: statuses('expenses'),
  });

  it('AC1, AC2, AC4: expires old loose inferences and week-old open decisions, once', async () => {
    clock = new Date('2026-12-01T03:00:00.000Z');
    const registered = expense('current', null);
    const line = Number(
      db
        .prepare(
          "INSERT INTO purchase_lines (expense_id, product_name, amount_cents) VALUES (?, 'pan', 100)",
        )
        .run(registered).lastInsertRowid,
    );
    const keptOnExpense = inference('expense', registered, ago(31));
    const keptOnLine = inference('purchase_line', line, ago(31));
    const loose = inference('expense', null, ago(31));
    const recent = inference('expense', null, ago(29));

    const receivedAt = (days: number) => ({
      source: `telegram:${days}`,
      receivedAt: ago(days),
      mimeTypes: ['image/jpeg'],
      now: ago(days),
    });
    const oldDocument = createReceiptDocument(db, receivedAt(8));
    const pendingExpense = expense('pending', oldDocument);
    const onPending = inference('expense', pendingExpense, ago(31));
    const weekOld = decision(oldDocument, ago(8));
    const recentDecision = decision(createReceiptDocument(db, receivedAt(6)), ago(6));

    const job = retention();
    const first = await job.retain();
    const after = snapshot();

    const status = (rows: Row[], id: number) => rows.find((row) => row.id === id)?.status;
    expect(status(after.assertions, keptOnExpense)).toBe('current');
    expect(status(after.assertions, keptOnLine)).toBe('current');
    expect(status(after.assertions, loose)).toBe('expired');
    expect(status(after.assertions, recent)).toBe('current');
    expect(status(after.assertions, onPending)).toBe('expired');
    expect(status(after.decisions, weekOld)).toBe('expired');
    expect(status(after.decisions, recentDecision)).toBe('open');
    expect(after.proposals).toEqual([
      { id: 1, status: 'rejected' },
      { id: 2, status: 'asked' },
    ]);
    // R-19 AC2: no expense is created; the provisional row is refuted.
    expect(status(after.expenses, pendingExpense)).toBe('refuted');
    expect(status(after.expenses, registered)).toBe('current');
    expect(first).toEqual({ inferencesExpired: 2, decisionsExpired: 1, receiptsDiscarded: 0 });

    const second = await job.retain();
    expect(second).toEqual({ inferencesExpired: 0, decisionsExpired: 0, receiptsDiscarded: 0 });
    expect(snapshot()).toEqual(after);
    expect(sent).toEqual([]);
  });

  it('AC2: a week-old decision left awaiting the correction text expires too', async () => {
    clock = new Date('2026-10-30T03:00:00.000Z');
    const document = createReceiptDocument(db, {
      source: 'telegram:1',
      receivedAt: ago(10),
      mimeTypes: ['image/jpeg'],
      now: ago(10),
    });
    const pendingExpense = expense('pending', document);
    const stale = decision(document, ago(10));
    // "Corregir" was pressed and no text followed (R-17 AC6 reopens it only after 15 minutes).
    awaitText(db, stale, ago(10));

    const result = await retention().retain();

    expect(result.decisionsExpired).toBe(1);
    expect(statuses('pending_decisions')).toEqual([{ id: stale, status: 'expired' }]);
    expect(statuses('expenses')).toEqual([{ id: pendingExpense, status: 'refuted' }]);
  });
});
