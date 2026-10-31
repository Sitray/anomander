import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type FakeTelegramApi,
  pngBytes,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { RECEIPT_READER_PROMPT } from '../../src/processor/receipt-reader.ts';
import { TEXT_INTERPRETER_PROMPT } from '../../src/processor/text-interpreter.ts';

// End to end (PRD §15): a receipt photo through the fake Telegram API, the real bot, the daemon
// and a SQLite file, with hand-authored recorded vision responses instead of a live model.
const PRINCIPAL = 4242;
const principal = { chatId: PRINCIPAL };
const FIXTURES = resolve(import.meta.dirname, '../fixtures/receipt-reader');
const recorded = (name: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));
// The receipts are dated 29 October; today is 30 October in Madrid.
const NOW = new Date('2026-10-30T10:00:05.000Z');

let scratch: string;
let inbox: string;
let api: FakeTelegramApi;
let anomander: Anomander;
let readerFixture: string;
let readerCalls: Context[];
/** The recent turns the text interpreter received (R-16 AC3). */
let interpreterRecent: unknown[];

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-receipt-'));
  inbox = join(scratch, 'inbox');
  readerCalls = [];
  interpreterRecent = [];
  api = await startFakeTelegramApi();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_INBOX_DIR: inbox,
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o',
  });
  const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
    if (context.systemPrompt === RECEIPT_READER_PROMPT) {
      readerCalls.push(context);
      return recorded(readerFixture);
    }
    const [turn] = context.messages;
    if (context.systemPrompt === TEXT_INTERPRETER_PROMPT && typeof turn?.content === 'string') {
      interpreterRecent.push(JSON.parse(turn.content).recent);
    }
    // The phraser fails, so S-1 goes out exactly as written in §12 (R-21 AC2).
    return { ...recorded('unreadable'), content: [], stopReason: 'error', errorMessage: 'offline' };
  };
  anomander = startAnomander(config, {
    complete,
    model: 'openai/gpt-4o-mini',
    visionModel: 'openai/gpt-4o',
    telegramApiRoot: api.apiRoot,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => NOW,
  });
  await anomander.started;
});

afterEach(async () => {
  await anomander.stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

const withDb = <T>(use: (db: Database.Database) => T): T => {
  const db = new Database(join(scratch, 'anomander.db'));
  try {
    return use(db);
  } finally {
    db.close();
  }
};
const query = <T>(sql: string): T[] => withDb((db) => db.prepare(sql).all() as T[]);

/** R-5 AC1: the principal's policy "Mercadona es supermercado". */
const addPolicy = () =>
  withDb((db) => {
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
  });

const sendPhoto = (fileId: string, options: { caption?: string; mediaGroupId?: string } = {}) => {
  api.putFile(fileId, pngBytes(fileId.length));
  api.push(updates.photo(principal, { fileId, ...options }));
};

const imagesLeft = () => readdirSync(inbox, { recursive: true });

describe('a receipt photo over Telegram', () => {
  it('registers a receipt that adds up under a policy without asking (R-6 AC1, R-8 AC1)', async () => {
    addPolicy();
    readerFixture = 'adds-up';
    sendPhoto('receipt');

    const [reply] = await api.waitForSent(1);

    expect(reply?.text).toBe('Apuntado: 23,40 € en Mercadona (supermercado).');
    expect(reply?.payload.reply_markup).toBeUndefined();
    await vi.waitFor(() =>
      expect(query("SELECT id FROM actions WHERE status = 'verified'")).toHaveLength(1),
    );
    expect(query('SELECT authorized_by FROM actions')).toEqual([{ authorized_by: 'permission:1' }]);
    expect(
      query('SELECT total_cents, mode, status, category_basis, document_id FROM expenses'),
    ).toEqual([
      {
        total_cents: 2340,
        mode: 'corroborated',
        status: 'current',
        category_basis: 'policy',
        document_id: 1,
      },
    ]);
    expect(query('SELECT product_name, quantity, amount_cents FROM purchase_lines')).toHaveLength(
      3,
    );
    // R-4 AC4: one code confirmation per extracted inference, each now confirmed.
    expect(
      query("SELECT predicate, status FROM assertions WHERE actor = 'processor' ORDER BY id"),
    ).toEqual(
      ['merchant', 'occurred_on', 'total', 'line', 'line', 'line'].map((predicate) => ({
        predicate,
        status: 'confirmed',
      })),
    );
    expect(
      query("SELECT id FROM assertions WHERE mode = 'confirmed' AND actor = 'code'"),
    ).toHaveLength(6);
    // R-3 AC1, R-8 AC1: the document and its observation; the images are gone.
    expect(query('SELECT kind, status, image_count, image_deleted_at FROM documents')).toEqual([
      { kind: 'receipt', status: 'read', image_count: 1, image_deleted_at: NOW.toISOString() },
    ]);
    expect(
      query("SELECT subject_type, mode FROM assertions WHERE predicate = 'images_received'"),
    ).toEqual([{ subject_type: 'document', mode: 'observed' }]);
    expect(imagesLeft()).toEqual([]);
  });

  it('asks S-3 with three buttons when the lines do not add up (R-6 AC2, AC3)', async () => {
    addPolicy();
    readerFixture = 'lines-mismatch';
    sendPhoto('receipt');

    const [reply] = await api.waitForSent(1);

    const question = 'No cuadra: las líneas suman 20,00 € y el total dice 23,40 €. ¿Qué hago?';
    expect(reply?.text).toBe(question);
    const [decision] = query<{ id: number }>('SELECT id FROM pending_decisions');
    expect(reply?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Apuntar', callback_data: `decision:${decision?.id}:0` },
          { text: 'Corregir', callback_data: `decision:${decision?.id}:1` },
          { text: 'Descartar', callback_data: `decision:${decision?.id}:2` },
        ],
      ],
    });
    // R-17 AC2: the decision knows the message that shows it.
    await vi.waitFor(() =>
      expect(
        query('SELECT question, options_json, status, channel_ref FROM pending_decisions'),
      ).toEqual([
        {
          question,
          options_json: JSON.stringify(['Apuntar', 'Corregir', 'Descartar']),
          status: 'open',
          channel_ref: `telegram:${reply?.messageId}`,
        },
      ]),
    );
    expect(query('SELECT status, mode FROM expenses')).toEqual([
      { status: 'pending', mode: 'inferred' },
    ]);
    expect(query('SELECT status FROM proposals')).toEqual([{ status: 'asked' }]);
    expect(query('SELECT id FROM actions')).toEqual([]);
    expect(imagesLeft()).toEqual([]);
  });

  it('gives the interpreter the receipt and the button press as recent turns (R-16 AC3)', async () => {
    addPolicy();
    readerFixture = 'lines-mismatch';
    sendPhoto('receipt', { caption: 'la compra' });
    const [question] = await api.waitForSent(1);
    const [decision] = query<{ id: number }>('SELECT id FROM pending_decisions');
    api.push(
      updates.callbackQuery(principal, `decision:${decision?.id}:2`, question?.messageId ?? 0),
    );
    const [, discarded] = await api.waitForSent(2);

    api.push(updates.text(principal, '¿y ese cuánto era?'));
    await api.waitForSent(3);

    expect(interpreterRecent).toEqual([
      [
        { principal: '[foto de ticket] la compra', reply: question?.text },
        { principal: '[botón: Descartar]', reply: discarded?.text },
      ],
    ]);
  });

  it('answers an unreadable receipt with S-5 and stores no expense (R-3 AC3, R-8 AC1)', async () => {
    readerFixture = 'unreadable';
    sendPhoto('receipt');

    const [reply] = await api.waitForSent(1);

    expect(reply?.text).toBe('No he podido leer el ticket. ¿Me escribes el total y el comercio?');
    expect(query('SELECT id FROM expenses')).toEqual([]);
    expect(query('SELECT status, image_deleted_at FROM documents')).toEqual([
      { status: 'unreadable', image_deleted_at: NOW.toISOString() },
    ]);
    expect(imagesLeft()).toEqual([]);
  });

  it('reads an album of 2 photos as one receipt in one processor call (R-3 AC4)', async () => {
    addPolicy();
    readerFixture = 'adds-up';
    sendPhoto('page-1', { mediaGroupId: 'album-1' });
    sendPhoto('page-2', { mediaGroupId: 'album-1' });

    await api.waitForSent(1, 5000);

    expect(query('SELECT source, image_count FROM documents')).toEqual([
      { source: 'telegram:album:album-1', image_count: 2 },
    ]);
    expect(readerCalls).toHaveLength(1);
    const content = readerCalls[0]?.messages[0]?.content;
    expect(
      Array.isArray(content) && content.filter((block) => block.type === 'image'),
    ).toHaveLength(2);
  });

  it('takes a category from the caption as declared, over the receipt (R-3 AC5)', async () => {
    readerFixture = 'caption-category';
    sendPhoto('receipt', { caption: 'cena, restaurantes' });

    const [reply] = await api.waitForSent(1);

    expect(reply?.text).toBe(
      '23,40 € en Casa Pepe, el 29 de octubre. Lo clasificaría como restaurantes. ¿Lo apunto?',
    );
    expect(query('SELECT category_basis, status FROM expenses')).toEqual([
      { category_basis: 'declared', status: 'pending' },
    ]);
    expect(
      query(
        "SELECT value_json, actor FROM assertions WHERE mode = 'declared' AND predicate = 'category'",
      ),
    ).toEqual([{ value_json: '"restaurantes"', actor: 'principal' }]);
    const userTurn = readerCalls[0]?.messages[0]?.content;
    const header = Array.isArray(userTurn) ? userTurn[0] : undefined;
    expect(header?.type === 'text' && JSON.parse(header.text).caption).toBe('cena, restaurantes');
  });
});
