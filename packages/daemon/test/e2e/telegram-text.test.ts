import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { REPLY_PHRASER_PROMPT } from '../../src/processor/reply-phraser.ts';

// End to end (PRD §15): a message through the fake Telegram API, the real bot, the daemon and a
// SQLite file, with recorded processor responses instead of a live model.
const PRINCIPAL = 4242;
const STRANGER = 9999;
const FIXTURES = resolve(import.meta.dirname, '../fixtures/text-interpreter');
const recorded = (name: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));
const PHRASED = '¡Hecho! He apuntado 23,00 € de la cena en restaurantes.';

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander;
let config: ReturnType<typeof loadConfig>;
/** `false` makes the processor never answer, as a hung model would. */
let processorAnswers: boolean;

const complete = async (_model: string, context: Context) => {
  if (!processorAnswers) return new Promise<never>(() => {});
  const phrasing = context.systemPrompt === REPLY_PHRASER_PROMPT;
  const reply = recorded('expense-23-space-euro');
  return phrasing ? { ...reply, content: [{ type: 'text' as const, text: PHRASED }] } : reply;
};

const start = async (overrides: Partial<ReturnType<typeof loadConfig>> = {}) => {
  anomander = startAnomander(
    { ...config, processorTimeoutMs: 200, ...overrides },
    {
      complete,
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  );
  await anomander.started;
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-'));
  api = await startFakeTelegramApi();
  config = loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
  });
  processorAnswers = true;
  await start();
});

afterEach(async () => {
  await anomander.stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

const query = <T>(sql: string): T[] => {
  const db = new Database(join(scratch, 'anomander.db'), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

describe('a text expense over Telegram', () => {
  it('registers "23 € cena", replies in the assistant voice and records the delivery', async () => {
    api.push(updates.text({ chatId: PRINCIPAL }, '23 € cena'));

    const [reply] = await api.waitForSent(1);
    expect(reply).toMatchObject({ chatId: PRINCIPAL, text: PHRASED });

    // R-2 AC1, R-9 AC2: the stored expense and the observation of the reply that was sent.
    await vi.waitFor(() =>
      expect(query("SELECT status FROM actions WHERE status = 'verified'")).toHaveLength(1),
    );
    expect(query('SELECT total_cents, mode, document_id, category_basis FROM expenses')).toEqual([
      { total_cents: 2300, mode: 'declared', document_id: null, category_basis: 'inferred' },
    ]);
    expect(
      query(`SELECT a.source, a.value_json FROM actions x
             JOIN assertions a ON a.id = x.verification_assertion_id`),
    ).toEqual([
      { source: `telegram:${reply?.messageId}`, value_json: JSON.stringify({ text: PHRASED }) },
    ]);
  });

  it('ignores a stranger and stores nothing (R-1 AC1)', async () => {
    const tables = () =>
      query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).map(({ name }) => [name, query(`SELECT * FROM "${name}"`).length]);
    const before = tables();

    api.push(updates.text({ chatId: STRANGER }, '23 € cena'));
    api.push(updates.text({ chatId: PRINCIPAL, chatType: 'group' }, '23 € cena'));
    // Updates are handled in order: once the principal's reply arrives, both were ignored.
    api.push(updates.voice({ chatId: PRINCIPAL }));
    await api.waitForSent(1);

    expect(api.sent.map(({ chatId }) => chatId)).toEqual([PRINCIPAL]);
    expect(tables()).toEqual(before);
  });

  it('R-22: a processor that does not answer gets S-22 and does not block the next message', async () => {
    processorAnswers = false;
    api.push(updates.text({ chatId: PRINCIPAL }, '23 € cena'));
    const [failed] = await api.waitForSent(1);

    processorAnswers = true;
    api.push(updates.text({ chatId: PRINCIPAL }, '23 € cena'));
    await api.waitForSent(2);

    expect(failed?.text).toBe(
      'Algo ha fallado y no he podido procesar tu mensaje. ¿Me lo vuelves a enviar en un rato?',
    );
    expect(api.sent[1]?.text).toBe(PHRASED);
    expect(query('SELECT total_cents FROM expenses')).toEqual([{ total_cents: 2300 }]);
  });

  it('R-12 AC4: with the daily AI budget spent, a text gets S-26 and nothing is stored', async () => {
    await anomander.stop();
    await start({ dailyAiCallLimit: 0 });

    api.push(updates.text({ chatId: PRINCIPAL }, '23 € cena'));
    const [reply] = await api.waitForSent(1);

    expect(reply?.text).toBe(
      'He llegado al límite diario de IA y hoy no puedo procesar más mensajes. ¿Me lo vuelves a enviar mañana?',
    );
    expect(query('SELECT id FROM expenses')).toEqual([]);
  });
});
