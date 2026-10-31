import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTelegramBot } from '@anomander/telegram';
import {
  type FakeTelegramApi,
  pngBytes,
  type SentMessage,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError } from '../../src/budget/ai-budget.ts';
import { createButtonHandler, createDecisionAnswers } from '../../src/decisions/answer.ts';
import { createExpenseCorrection } from '../../src/decisions/correction.ts';
import { createTextRouter } from '../../src/decisions/router.ts';
import { createReceiptExpenseHandler } from '../../src/expenses/receipt-expense.ts';
import { createTextExpenseHandler } from '../../src/expenses/text-expense.ts';
import {
  CORRECTION_INTERPRETER_PROMPT,
  createPiAiCorrectionInterpreter,
} from '../../src/processor/correction-interpreter.ts';
import {
  createPiAiReceiptReader,
  RECEIPT_READER_PROMPT,
} from '../../src/processor/receipt-reader.ts';
import { verbatimReplies } from '../../src/processor/reply-phraser.ts';
import { createPiAiTextInterpreter } from '../../src/processor/text-interpreter.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// End to end (PRD §15): answering a receipt's pending decision over the fake Telegram API, with
// the real bot, the daemon's handlers wired as the composition root will wire them, a SQLite
// file and recorded processor responses (R-6 AC4, R-7, R-17).
const PRINCIPAL = 4242;
const STRANGER = 9999;
const principal = { chatId: PRINCIPAL };
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const recorded = (path: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${path}.json`), 'utf8'));
const NOW = new Date('2026-10-30T10:00:05.000Z');

const S3 = 'No cuadra: las líneas suman 20,00 € y el total dice 23,40 €. ¿Qué hago?';
const S7 = '¿Qué cambio? Escríbelo, por ejemplo: total 28,40';
const S19 = 'Esa pregunta ya no está abierta.';
const [APUNTAR, CORREGIR, DESCARTAR] = [0, 1, 2];

let scratch: string;
let api: FakeTelegramApi;
let db: Database.Database;
let bot: ReturnType<typeof createTelegramBot>;
let polling: Promise<void>;
let clock: Date;
/** `true` refuses processor calls as `budgeted` does once the daily cap is reached (R-12). */
let budgetSpent: boolean;
let correctionFixture: string;
/** What the correction interpreter received (R-7 AC2). */
let correctionTurns: unknown[];

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-decisions-'));
  clock = NOW;
  budgetSpent = false;
  correctionFixture = 'total-28-40';
  correctionTurns = [];
  const now = () => clock;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  api = await startFakeTelegramApi();
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
  const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
    if (context.systemPrompt === RECEIPT_READER_PROMPT) {
      return recorded('receipt-reader/lines-mismatch');
    }
    if (context.systemPrompt === CORRECTION_INTERPRETER_PROMPT) {
      if (budgetSpent) throw new AiBudgetExhaustedError();
      const [turn] = context.messages;
      if (typeof turn?.content === 'string') correctionTurns.push(JSON.parse(turn.content));
      return recorded(`correction-interpreter/${correctionFixture}`);
    }
    return recorded('text-interpreter/conversation');
  };
  const model = 'openai/gpt-4o-mini';
  const onReceipt = createReceiptExpenseHandler({
    db,
    reader: createPiAiReceiptReader({ complete, model, logger }),
    phraser: verbatimReplies,
    inboxDir: join(scratch, 'inbox'),
    timeZone: 'Europe/Madrid',
    now,
    processorSource: `processor:${model}`,
    logger,
  });
  const onText = createTextRouter({
    db,
    corrections: {
      register_expense: createExpenseCorrection({
        db,
        interpreter: createPiAiCorrectionInterpreter({ complete, model, logger }),
        timeZone: 'Europe/Madrid',
        now,
        logger,
      }),
    },
    otherwise: createTextExpenseHandler({
      db,
      interpreter: createPiAiTextInterpreter({ complete, model, logger }),
      phraser: verbatimReplies,
      timeZone: 'Europe/Madrid',
      now,
      processorSource: `processor:${model}`,
      logger,
    }),
    now,
  });
  const onButton = createButtonHandler({
    db,
    answers: createDecisionAnswers({ phraser: verbatimReplies, logger }),
    now,
    logger,
  });
  bot = createTelegramBot({
    token: api.token,
    apiRoot: api.apiRoot,
    principalChatId: PRINCIPAL,
    onText,
    onReceipt,
    onButton,
    logger,
  });
  await new Promise<void>((started) => {
    polling = bot.start({ onStart: () => started() });
  });
});

afterEach(async () => {
  await bot.stop();
  await polling;
  await api.close();
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const query = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

/** R-5 AC1: the principal's policy "Mercadona es supermercado". */
const addPolicy = () => {
  const declaration = db
    .prepare(
      `INSERT INTO assertions (subject_type, predicate, value_json, mode, actor, source, status,
         created_at)
       VALUES ('policy', 'rule', '{}', 'declared', 'principal', 'telegram:1', 'current', ?)`,
    )
    .run(NOW.toISOString());
  db.prepare(
    'INSERT INTO policies (rule_json, declared_by_assertion_id, created_at) VALUES (?, ?, ?)',
  ).run(
    JSON.stringify({ merchant: 'Mercadona', category: 'supermercado' }),
    declaration.lastInsertRowid,
    NOW.toISOString(),
  );
};

/** A receipt whose lines do not add up: S-3, a pending expense and an open decision (R-6 AC2). */
const askS3 = async (): Promise<{ decisionId: number; question: SentMessage }> => {
  addPolicy();
  api.putFile('receipt', pngBytes(1));
  api.push(updates.photo(principal, { fileId: 'receipt' }));
  const [question] = await api.waitForSent(1);
  expect(question?.text).toBe(S3);
  // R-17 AC2: the decision knows its message once the delivery is reported.
  await vi.waitFor(() =>
    expect(query('SELECT id FROM pending_decisions WHERE channel_ref IS NOT NULL')).toHaveLength(1),
  );
  const [decision] = query<{ id: number }>('SELECT id FROM pending_decisions');
  if (question === undefined || decision === undefined) throw new Error('no decision');
  return { decisionId: decision.id, question };
};

/** Presses option `index` of the decision under `question`; resolves with the reply. */
const press = async (
  question: SentMessage,
  decisionId: number,
  index: number,
  sender: { chatId: number; fromId?: number } = principal,
) => {
  const before = api.sent.length;
  api.push(updates.callbackQuery(sender, `decision:${decisionId}:${index}`, question.messageId));
  return (await api.waitForSent(before + 1)).at(-1);
};

const say = async (text: string, replyToMessageId?: number) => {
  const before = api.sent.length;
  api.push(
    updates.text(principal, text, replyToMessageId === undefined ? {} : { replyToMessageId }),
  );
  return (await api.waitForSent(before + 1)).at(-1);
};

const ledger = () => ({
  expenses: query('SELECT total_cents, status, mode FROM expenses'),
  proposals: query('SELECT status FROM proposals'),
  decisions: query('SELECT status, awaiting_since, answer_assertion_id FROM pending_decisions'),
  actions: query('SELECT authorized_by FROM actions'),
  assertions: query('SELECT id, status FROM assertions'),
});

describe('answering a pending receipt decision', () => {
  it('"Apuntar" registers the expense, authorized and confirmed by the principal (R-6 AC4)', async () => {
    const { decisionId, question } = await askS3();

    const reply = await press(question, decisionId, APUNTAR);

    expect(reply?.text).toBe('Apuntado: 23,40 € en Mercadona (supermercado).');
    expect(query('SELECT status, mode, created_by_action_id FROM expenses')).toEqual([
      { status: 'current', mode: 'confirmed', created_by_action_id: 1 },
    ]);
    expect(query('SELECT status FROM proposals')).toEqual([{ status: 'executed' }]);
    await vi.waitFor(() =>
      expect(query('SELECT authorized_by, status FROM actions')).toEqual([
        { authorized_by: 'principal', status: 'verified' },
      ]),
    );
    // One confirmation by the principal per inference, each now confirmed (§7.2).
    expect(
      query("SELECT predicate, status FROM assertions WHERE actor = 'processor' ORDER BY id"),
    ).toEqual(
      ['merchant', 'occurred_on', 'total', 'line', 'line', 'line'].map((predicate) => ({
        predicate,
        status: 'confirmed',
      })),
    );
    const confirmations = query<{ id: number; predicate: string; source: string }>(
      "SELECT id, predicate, source FROM assertions WHERE mode = 'confirmed' AND actor = 'principal'",
    );
    expect(confirmations).toHaveLength(6);
    expect(confirmations[0]?.source).toBe(`decision:${decisionId}:0`);
    const total = confirmations.find((confirmation) => confirmation.predicate === 'total');
    expect(query('SELECT status, answer_assertion_id FROM pending_decisions')).toEqual([
      { status: 'answered', answer_assertion_id: total?.id },
    ]);
  });

  it('"Descartar" rejects the proposal and leaves no current expense (R-6 AC4)', async () => {
    const { decisionId, question } = await askS3();

    const reply = await press(question, decisionId, DESCARTAR);

    expect(reply?.text).toBe('Descartado: no he apuntado 23,40 € en Mercadona.');
    expect(query("SELECT id FROM expenses WHERE status = 'current'")).toEqual([]);
    expect(query('SELECT status FROM expenses')).toEqual([{ status: 'refuted' }]);
    expect(query('SELECT status FROM proposals')).toEqual([{ status: 'rejected' }]);
    expect(query('SELECT status FROM pending_decisions')).toEqual([{ status: 'answered' }]);
    expect(query('SELECT id FROM actions')).toEqual([]);
  });

  it('"Corregir" asks S-7 and the next text corrects the expense with S-8 (R-7, R-17 AC3)', async () => {
    const { decisionId, question } = await askS3();

    expect((await press(question, decisionId, CORREGIR))?.text).toBe(S7);
    expect(query('SELECT status, awaiting_since FROM pending_decisions')).toEqual([
      { status: 'awaiting_text', awaiting_since: NOW.toISOString() },
    ]);

    const reply = await say('total 28,40');

    expect(reply?.text).toBe('Corregido: 28,40 € en Mercadona (supermercado).');
    const [old] = query<{ id: number; status: string }>(
      "SELECT id, status FROM assertions WHERE actor = 'processor' AND predicate = 'total'",
    );
    expect(old?.status).toBe('refuted');
    const [declared] = query<{ id: number }>(
      "SELECT id FROM assertions WHERE mode = 'declared' AND predicate = 'total'",
    );
    expect(
      query(
        `SELECT value_json, actor, status, supersedes_id FROM assertions
         WHERE mode = 'declared' AND predicate = 'total'`,
      ),
    ).toEqual([
      { value_json: '2840', actor: 'principal', status: 'current', supersedes_id: old?.id },
    ]);
    expect(query('SELECT total_cents, status FROM expenses')).toEqual([
      { total_cents: 2840, status: 'current' },
    ]);
    expect(query('SELECT status, answer_assertion_id FROM pending_decisions')).toEqual([
      { status: 'answered', answer_assertion_id: declared?.id },
    ]);
    await vi.waitFor(() =>
      expect(query('SELECT authorized_by, status FROM actions')).toEqual([
        { authorized_by: 'principal', status: 'verified' },
      ]),
    );
  });

  it('a corrected date changes the date of the expense (R-7 AC2)', async () => {
    const { decisionId, question } = await askS3();
    await press(question, decisionId, CORREGIR);
    correctionFixture = 'occurred-on-28';

    const reply = await say('fecha 28/10');

    expect(reply?.text).toBe('Corregido: 23,40 € en Mercadona (supermercado).');
    expect(correctionTurns).toMatchObject([{ today: '2026-10-30' }]);
    const [old] = query<{ id: number; status: string }>(
      "SELECT id, status FROM assertions WHERE actor = 'processor' AND predicate = 'occurred_on'",
    );
    expect(old?.status).toBe('refuted');
    expect(
      query(
        `SELECT value_json, actor, status, supersedes_id FROM assertions
         WHERE mode = 'declared' AND predicate = 'occurred_on'`,
      ),
    ).toEqual([
      { value_json: '"2026-10-28"', actor: 'principal', status: 'current', supersedes_id: old?.id },
    ]);
    expect(query('SELECT occurred_on, status FROM expenses')).toEqual([
      { occurred_on: '2026-10-28', status: 'current' },
    ]);
  });

  it('a corrected date after today is ignored and S-7 asked again (R-7 AC2)', async () => {
    const { decisionId, question } = await askS3();
    await press(question, decisionId, CORREGIR);
    correctionFixture = 'occurred-on-future';
    const before = ledger();

    expect((await say('fecha 2/11'))?.text).toBe(S7);

    expect(ledger()).toEqual(before);
    expect(query('SELECT occurred_on FROM expenses')).toEqual([{ occurred_on: '2026-10-29' }]);
  });

  it('with the daily AI budget spent, a correction gets S-26 and keeps waiting (R-12 AC4)', async () => {
    const { decisionId, question } = await askS3();
    await press(question, decisionId, CORREGIR);
    const before = ledger();
    budgetSpent = true;

    const reply = await say('total 28,40');

    expect(reply?.text).toBe(
      'He llegado al límite diario de IA y hoy no puedo procesar más mensajes. ¿Me lo vuelves a enviar mañana?',
    );
    expect(ledger()).toEqual(before);
  });

  it('a Telegram reply to the decision message corrects it (R-17 AC2)', async () => {
    const { question } = await askS3();

    const reply = await say('total 28,40', question.messageId);

    expect(reply?.text).toBe('Corregido: 28,40 € en Mercadona (supermercado).');
    expect(query('SELECT total_cents, status FROM expenses')).toEqual([
      { total_cents: 2840, status: 'current' },
    ]);
  });

  it('a button of a decision that is no longer open gets S-19 and changes nothing (R-17 AC1)', async () => {
    const { decisionId, question } = await askS3();
    await press(question, decisionId, APUNTAR);
    await vi.waitFor(() =>
      expect(query("SELECT id FROM actions WHERE status = 'verified'")).toHaveLength(1),
    );
    const before = ledger();

    expect((await press(question, decisionId, DESCARTAR))?.text).toBe(S19);
    expect((await press(question, decisionId + 1, APUNTAR))?.text).toBe(S19);
    expect((await press(question, decisionId, 7))?.text).toBe(S19);
    expect(ledger()).toEqual(before);
  });

  it('a decision awaiting text for 15 minutes is open again; its buttons still work (R-17 AC6)', async () => {
    const { decisionId, question } = await askS3();
    await press(question, decisionId, CORREGIR);

    clock = new Date(NOW.getTime() + 15 * 60 * 1000);
    const reply = await say('hola');

    // AC5: the text is not a correction any more; it goes to the processor.
    expect(reply?.text).toBe(
      '¡Hola! Cuando quieras, dime un gasto, por ejemplo: 23,40 en Mercadona.',
    );
    expect(query('SELECT status, awaiting_since FROM pending_decisions')).toEqual([
      { status: 'open', awaiting_since: null },
    ]);
    expect((await press(question, decisionId, APUNTAR))?.text).toBe(
      'Apuntado: 23,40 € en Mercadona (supermercado).',
    );
  });

  it('ignores a button press from anyone but the principal (R-1)', async () => {
    const { decisionId, question } = await askS3();
    api.push(
      updates.callbackQuery(
        { chatId: PRINCIPAL, fromId: STRANGER },
        `decision:${decisionId}:${APUNTAR}`,
        question.messageId,
      ),
    );

    // Updates are handled in order: the principal's press answers after the stranger's.
    const reply = await press(question, decisionId, DESCARTAR);

    expect(reply?.text).toBe('Descartado: no he apuntado 23,40 € en Mercadona.');
    expect(api.sent).toHaveLength(2);
    expect(query('SELECT id FROM actions')).toEqual([]);
  });
});
