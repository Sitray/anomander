import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessorInference } from '@anomander/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTextExpenseHandler } from '../../src/expenses/text-expense.ts';
import { type ReplyPhraser, verbatimReplies } from '../../src/processor/reply-phraser.ts';
import type { Interpretation, TextInterpreter } from '../../src/processor/text-interpreter.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { insertAssertion } from '../../src/store/expenses.ts';
import { listMemories } from '../../src/store/memory.ts';

// R-2, R-5, R-9, R-16 through the handler, on a real SQLite file and a fake processor.
// 23:30 UTC on 30 October is already 31 October in Madrid (UTC+1).
const NOW = new Date('2026-10-30T23:30:00.000Z');
const TODAY = '2026-10-31';
const RECEIVED_AT = '2026-10-30T23:29:58.000Z';

let scratch: string;
let db: Database.Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-text-expense-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const inferred = (predicate: string, value_json: ProcessorInference['value_json']) => ({
  subject_type: 'expense',
  subject_id: null,
  predicate,
  value_json,
  mode: 'inferred' as const,
  basis_json: { quote: String(value_json) },
  confidence: 0.9,
});

const expense = (...inferences: ProcessorInference[]): Interpretation => ({
  kind: 'expense',
  inferences,
  memories: [],
});

const handlerFor = (interpretation: Interpretation, phraser: ReplyPhraser = verbatimReplies) => {
  const interpreter = vi.fn<TextInterpreter>(async () => interpretation);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handle = createTextExpenseHandler({
    db,
    interpreter,
    timeZone: 'Europe/Madrid',
    now: () => NOW,
    processorSource: 'processor:openai/gpt-4o-mini',
    phraser,
    logger,
  });
  return { handle, interpreter, logger };
};

const send = (handle: ReturnType<typeof handlerFor>['handle'], text: string) =>
  handle({ text, channelRef: 'telegram:42', receivedAt: RECEIVED_AT });

const rowCounts = (): Record<string, number> => {
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n,
    ]),
  );
};

interface ExpenseRow {
  id: number;
  total_cents: number;
  occurred_on: string;
  mode: string;
  status: string;
  document_id: number | null;
  category: string | null;
  category_basis: string | null;
  merchant: string | null;
  created_by_action_id: number;
}

const onlyExpense = (): ExpenseRow => {
  const rows = db
    .prepare<[], ExpenseRow>(
      `SELECT e.*, c.name AS category, m.name AS merchant FROM expenses e
       LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN entities m ON m.id = e.merchant_id`,
    )
    .all();
  expect(rows).toHaveLength(1);
  return rows[0] as ExpenseRow;
};

const assertionsOf = (subjectType: string, subjectId: number) =>
  db
    .prepare('SELECT * FROM assertions WHERE subject_type = ? AND subject_id = ? ORDER BY id')
    .all(subjectType, subjectId) as Record<string, unknown>[];

describe('text expense handler', () => {
  it('registers "23 € cena" as a declared expense, replies S-2 and verifies delivery', async () => {
    const { handle, interpreter } = handlerFor(
      expense(inferred('total', 2300), inferred('category', 'restaurantes')),
    );

    const reply = await send(handle, '23 € cena');

    expect(interpreter).toHaveBeenCalledWith({
      text: '23 € cena',
      today: TODAY,
      categories: ['restaurantes', 'supermercado'],
      recent: [],
      memories: [],
    });
    expect(reply.text).toBe('Apuntado: 23,00\u00a0€ (restaurantes).');
    const row = onlyExpense();
    expect(row).toMatchObject({
      total_cents: 2300,
      mode: 'declared',
      status: 'current',
      document_id: null,
      occurred_on: TODAY,
      merchant: null,
    });
    expect(assertionsOf('expense', row.id)).toEqual([
      expect.objectContaining({
        predicate: 'total',
        value_json: '2300',
        mode: 'declared',
        actor: 'principal',
        source: 'telegram:42',
        status: 'current',
      }),
      expect.objectContaining({ predicate: 'total', mode: 'inferred', actor: 'processor' }),
      expect.objectContaining({
        predicate: 'category',
        mode: 'inferred',
        actor: 'processor',
        source: 'processor:openai/gpt-4o-mini',
      }),
    ]);
    const action = () =>
      db.prepare('SELECT * FROM actions WHERE id = ?').get(row.created_by_action_id) as Record<
        string,
        unknown
      >;
    expect(action()).toMatchObject({
      authorized_by: 'principal',
      status: 'executed',
      verification_assertion_id: null,
    });
    expect(db.prepare('SELECT matter_id, operation, status FROM proposals').all()).toEqual([
      { matter_id: 1, operation: 'register_expense', status: 'executed' },
    ]);

    reply.onDelivered?.({ channelRef: 'telegram:43', deliveredAt: '2026-10-30T23:30:01.000Z' });

    const verified = action();
    expect(verified.status).toBe('verified');
    expect(
      db.prepare('SELECT * FROM assertions WHERE id = ?').get(verified.verification_assertion_id),
    ).toMatchObject({
      subject_type: 'action',
      subject_id: row.created_by_action_id,
      predicate: 'reply_delivered',
      mode: 'observed',
      actor: 'source',
      source: 'telegram:43',
      valid_at: '2026-10-30T23:30:01.000Z',
      value_json: JSON.stringify({ text: 'Apuntado: 23,00\u00a0€ (restaurantes).' }),
    });
  });

  it('builds the reply from the stored row, not from the proposal (R-9 AC1)', async () => {
    db.exec(`CREATE TEMP TRIGGER rewrite_total AFTER INSERT ON expenses BEGIN
      UPDATE expenses SET total_cents = 4210 WHERE id = NEW.id; END`);
    const { handle } = handlerFor(
      expense(inferred('total', 2340), inferred('merchant', 'Mercadona')),
    );

    expect((await send(handle, '23,40 Mercadona')).text).toBe(
      'Apuntado: 42,10\u00a0€ en Mercadona (sin clasificar).',
    );
  });

  it('words the reply around the stored facts and records the text it sent (R-21)', async () => {
    const phraser = vi.fn<ReplyPhraser>(async ({ facts }) => `Hecho: ${facts.join(', ')}.`);
    const { handle } = handlerFor(
      expense(inferred('total', 2340), inferred('merchant', 'Mercadona')),
      phraser,
    );

    const reply = await send(handle, '23,40 Mercadona');
    reply.onDelivered?.({ channelRef: 'telegram:43', deliveredAt: '2026-10-30T23:30:01.000Z' });

    expect(phraser).toHaveBeenCalledWith({
      reference: 'Apuntado: 23,40 € en Mercadona (sin clasificar).',
      facts: ['23,40 €', 'Mercadona', 'sin clasificar'],
      message: '23,40 Mercadona',
    });
    expect(reply.text).toBe('Hecho: 23,40 €, Mercadona, sin clasificar.');
    expect(
      db.prepare("SELECT value_json FROM assertions WHERE predicate = 'reply_delivered'").get(),
    ).toEqual({ value_json: JSON.stringify({ text: reply.text }) });
  });

  it.each([
    {
      name: 'policy',
      text: '40 en Mercadona',
      inferences: [inferred('merchant', 'Mercadona'), inferred('category', 'restaurantes')],
      category: 'supermercado',
      basis: 'policy',
      reply: 'Apuntado: 40,00\u00a0€ en Mercadona (supermercado).',
    },
    {
      name: 'declared',
      text: '40 en Mercadona, categoría Restaurantes',
      inferences: [
        inferred('merchant', 'Mercadona'),
        inferred('declared_category', 'restaurantes'),
      ],
      category: 'restaurantes',
      basis: 'declared',
      reply: 'Apuntado: 40,00\u00a0€ en Mercadona (restaurantes).',
    },
    {
      name: 'declared but not written in the text',
      text: '40 cena',
      inferences: [
        inferred('declared_category', 'supermercado'),
        inferred('category', 'restaurantes'),
      ],
      category: 'restaurantes',
      basis: 'inferred',
      reply: 'Apuntado: 40,00\u00a0€ (restaurantes).',
    },
    {
      name: 'inferred existing',
      text: '40 cena',
      inferences: [inferred('category', 'restaurantes')],
      category: 'restaurantes',
      basis: 'inferred',
      reply: 'Apuntado: 40,00\u00a0€ (restaurantes).',
    },
    {
      name: 'inferred non-existing',
      text: '40 gasolina',
      inferences: [inferred('category', 'gasolina')],
      category: null,
      basis: null,
      reply: 'Apuntado: 40,00\u00a0€ (sin clasificar).',
    },
  ])('sets category_basis for a $name category (R-2 AC3, R-5)', async (example) => {
    const declaration = insertAssertion(db, {
      subject_type: 'policy',
      subject_id: null,
      predicate: 'rule',
      value_json: { merchant: 'mercadona', category: 'supermercado' },
      mode: 'declared',
      actor: 'principal',
      source: 'telegram:1',
      basis_json: null,
      confidence: null,
      valid_at: RECEIVED_AT,
      expires_at: null,
      status: 'current',
      supersedes_id: null,
      confirms_id: null,
    });
    db.prepare(
      `INSERT INTO policies (rule_json, declared_by_assertion_id, created_at)
       VALUES ('{"merchant":"mercadona","category":"supermercado"}', ?, ?)`,
    ).run(declaration, RECEIVED_AT);
    const { handle } = handlerFor(expense(inferred('total', 4000), ...example.inferences));

    expect((await send(handle, example.text)).text).toBe(example.reply);
    const row = onlyExpense();
    expect([row.category, row.category_basis]).toEqual([example.category, example.basis]);
    const declaredCategory = assertionsOf('expense', row.id).filter(
      (assertion) => assertion.predicate === 'category' && assertion.mode === 'declared',
    );
    expect(declaredCategory).toHaveLength(example.basis === 'declared' ? 1 : 0);
  });

  it('stores only the inferences the expense rests on (§10)', async () => {
    const { handle } = handlerFor(
      expense(
        inferred('total', 2300),
        inferred('total', 9900),
        inferred('occurred_on', '2026-02-30'),
        inferred('declared_category', 'gasolina'),
        inferred('category', 'restaurantes'),
      ),
    );

    await send(handle, '23 € cena');

    expect(
      db.prepare("SELECT predicate, value_json FROM assertions WHERE mode = 'inferred'").all(),
    ).toEqual([
      { predicate: 'total', value_json: '2300' },
      { predicate: 'category', value_json: '"restaurantes"' },
    ]);
  });

  it('reuses a merchant entity whatever its case', async () => {
    await send(
      handlerFor(expense(inferred('total', 500), inferred('merchant', 'Mercadona'))).handle,
      '5 Mercadona',
    );
    await send(
      handlerFor(expense(inferred('total', 600), inferred('merchant', 'MERCADONA'))).handle,
      '6 MERCADONA',
    );

    expect(db.prepare("SELECT name FROM entities WHERE kind = 'merchant'").all()).toEqual([
      { name: 'Mercadona' },
    ]);
  });

  it.each([
    {
      name: 'a total not written in the text',
      text: 'veinte euros cena',
      interpretation: expense(inferred('total', 2000)),
    },
    {
      name: 'no total',
      text: 'cena en Casa Paco',
      interpretation: expense(inferred('merchant', 'Casa Paco')),
    },
    {
      name: 'an unusable processor response',
      text: '23 cena',
      interpretation: { kind: 'invalid', reason: 'not JSON' } as const,
    },
  ])(
    'replies S-16 and stores nothing for $name (R-2 AC6, A3)',
    async ({ text, interpretation }) => {
      const before = rowCounts();
      const { handle } = handlerFor(interpretation);

      const reply = await send(handle, text);

      expect(reply.text).toBe('No tengo claro el importe. ¿Me lo escribes? Por ejemplo: 23,40');
      expect(reply.onDelivered).toBeUndefined();
      expect(rowCounts()).toEqual(before);
    },
  );

  it.each([
    {
      name: 'an inferred date',
      inferences: [inferred('occurred_on', '2026-10-30')],
      stored: '2026-10-30',
    },
    { name: 'no date', inferences: [], stored: TODAY },
    {
      name: 'a date that is not a calendar date',
      inferences: [inferred('occurred_on', '2026-02-30')],
      stored: TODAY,
    },
  ])('stores $name as the expense date in TZ (R-2 AC7)', async ({ inferences, stored }) => {
    const { handle } = handlerFor(expense(inferred('total', 1200), ...inferences));

    await send(handle, '12 ayer');

    expect(onlyExpense().occurred_on).toBe(stored);
  });

  it('rejects a date later than today with S-21 and stores nothing (R-2 AC7)', async () => {
    const before = rowCounts();
    const { handle } = handlerFor(
      expense(inferred('total', 1200), inferred('occurred_on', '2026-11-05')),
    );

    const reply = await send(handle, '12 el jueves');

    expect(reply.text).toBe(
      'La fecha 5 de noviembre es posterior a hoy. ¿Me dices cuándo fue el gasto?',
    );
    expect(rowCounts()).toEqual(before);
  });

  it('remembers the facts found in an expense message without changing the reply (R-23 AC2)', async () => {
    const { handle } = handlerFor({
      kind: 'expense',
      inferences: [inferred('total', 2300), inferred('category', 'restaurantes')],
      memories: [
        {
          text: 'Cena fuera a menudo',
          quote: 'cena',
          said: false,
          confidence: 0.6,
          replaces: null,
        },
      ],
    });

    const reply = await send(handle, '23 € cena');

    expect(reply.text).toBe('Apuntado: 23,00\u00a0€ (restaurantes).');
    expect(onlyExpense()).toMatchObject({ total_cents: 2300, category: 'restaurantes' });
    expect(listMemories(db)).toEqual([
      { id: expect.any(Number), text: 'Cena fuera a menudo', mode: 'inferred' },
    ]);
    expect(
      db
        .prepare(
          "SELECT actor, source, confidence, valid_at FROM assertions WHERE predicate = 'memory'",
        )
        .all(),
    ).toEqual([
      { actor: 'processor', source: 'telegram:42', confidence: 0.6, valid_at: RECEIVED_AT },
    ]);
  });

  it('answers open conversation with its reply and persists nothing (R-16)', async () => {
    const before = rowCounts();
    const { handle } = handlerFor({
      kind: 'conversation',
      reply: '¡Hola! ¿En qué te ayudo?',
      memories: [],
    });

    const reply = await send(handle, 'hola');

    expect(reply).toEqual({ text: '¡Hola! ¿En qué te ayudo?' });
    expect(rowCounts()).toEqual(before);
  });
});
