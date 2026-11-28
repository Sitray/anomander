import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ChatEvent, LOCAL_CHANNEL_PROTOCOL } from '@anomander/protocol';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { textInterpreterPrompt } from '../../src/processor/text-interpreter.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// End to end (PRD §15): a free query on the expenses (R-30), the fourth capability (R-24),
// through the fake Telegram API, the local channel, the real bot and a SQLite file. The processor
// only picks the period and the filters; every figure is computed by code from the rows.
const PRINCIPAL = 4242;
const principal = { chatId: PRINCIPAL };
const TOKEN = 'expense-query-test-token-0123456789abcdef';
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const recorded = (name: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));
// Tuesday 24 November 2026, 12:00 in Madrid.
const NOW = new Date('2026-11-24T11:00:00.000Z');
const S22 =
  'Algo ha fallado y no he podido procesar tu mensaje. ¿Me lo vuelves a enviar en un rato?';
/** `Intl.NumberFormat('es-ES')` puts a no-break space between the amount and `€`. */
const eur = (amount: string) => `${amount} €`;

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander;
/** What the text interpreter answers, by message. */
let interpretations: Map<string, unknown>;
/** How many times the text interpreter was called. */
let interpreterCalls: number;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };

const answering = (envelope: unknown): AssistantMessage => ({
  ...recorded('text-interpreter/conversation'),
  content: [{ type: 'text', text: JSON.stringify(envelope) }],
});

const dbPath = () => join(scratch, 'anomander.db');

/**
 * November 2026: Mercadona 45,20 € and Lidl 12,50 € (supermercado), La Tasca 23,00 €
 * (restaurantes) and 8,00 € with no category nor merchant, all current; a pending 30,00 € at
 * Mercadona on the 22nd; a refuted 99,99 € at La Tasca; and 50,00 € at Mercadona in October.
 */
const seed = () => {
  const db = openDatabase(dbPath());
  applyMigrations(db);
  const merchant = (name: string) =>
    Number(
      db
        .prepare("INSERT INTO entities (kind, name, created_at) VALUES ('merchant', ?, ?)")
        .run(name, NOW.toISOString()).lastInsertRowid,
    );
  const mercadona = merchant('Mercadona');
  const lidl = merchant('Lidl');
  const tasca = merchant('La Tasca');
  const insert = db.prepare(
    `INSERT INTO expenses (merchant_id, occurred_on, total_cents, category_id, mode, status, created_at)
     VALUES (?, ?, ?, (SELECT id FROM categories WHERE name = ?), 'declared', ?, ?)`,
  );
  const rows: [number | null, string, number, string | null, string][] = [
    [mercadona, '2026-11-03', 4520, 'supermercado', 'current'],
    [tasca, '2026-11-10', 2300, 'restaurantes', 'current'],
    [lidl, '2026-11-20', 1250, 'supermercado', 'current'],
    [null, '2026-11-21', 800, null, 'current'],
    [mercadona, '2026-11-22', 3000, 'supermercado', 'pending'],
    [tasca, '2026-11-15', 9999, 'restaurantes', 'refuted'],
    [mercadona, '2026-10-30', 5000, 'supermercado', 'current'],
  ];
  for (const row of rows) insert.run(...row, NOW.toISOString());
  db.close();
};

const start = async () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: dbPath(),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o',
    ANOMANDER_LOCAL_TOKEN: TOKEN,
    TZ: 'Europe/Madrid',
  });
  const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
    const [turn] = context.messages;
    if (context.systemPrompt === textInterpreterPrompt() && typeof turn?.content === 'string') {
      interpreterCalls += 1;
      const { message } = JSON.parse(turn.content);
      const envelope = interpretations.get(message);
      if (envelope === undefined) throw new Error(`no interpretation for ${message}`);
      return answering(envelope);
    }
    return { ...answering({}), content: [], stopReason: 'error', errorMessage: 'offline' };
  };
  anomander = startAnomander(
    { ...config, localPort: 0 },
    {
      complete,
      model: 'openai/gpt-4o-mini',
      visionModel: 'openai/gpt-4o',
      telegramApiRoot: api.apiRoot,
      logger,
      now: () => NOW,
    },
  );
  await anomander.started;
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-expense-query-'));
  interpretations = new Map();
  interpreterCalls = 0;
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  api = await startFakeTelegramApi();
  seed();
  await start();
});

afterEach(async () => {
  await anomander.stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

const query = <T>(sql: string): T[] => {
  const db = new Database(dbPath(), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

/**
 * Adds expenses while the daemon runs, through a second connection: each row is its merchant
 * (created when new, `null` for none), date, cents, category and status.
 */
const addRows = (rows: [string | null, string, number, string | null, string][]) => {
  const db = new Database(dbPath());
  try {
    const merchantId = (name: string) =>
      db.prepare<[string], { id: number }>('SELECT id FROM entities WHERE name = ?').get(name)
        ?.id ??
      Number(
        db
          .prepare("INSERT INTO entities (kind, name, created_at) VALUES ('merchant', ?, ?)")
          .run(name, NOW.toISOString()).lastInsertRowid,
      );
    const insert = db.prepare(
      `INSERT INTO expenses (merchant_id, occurred_on, total_cents, category_id, mode, status, created_at)
       VALUES (?, ?, ?, (SELECT id FROM categories WHERE name = ?), 'declared', ?, ?)`,
    );
    for (const [merchant, ...rest] of rows) {
      insert.run(merchant === null ? null : merchantId(merchant), ...rest, NOW.toISOString());
    }
  } finally {
    db.close();
  }
};

/** Sends `text` over Telegram with the interpreter answering `envelope`; the reply text. */
const say = async (text: string, envelope: unknown) => {
  interpretations.set(text, envelope);
  const before = api.sent.length;
  api.push(updates.text(principal, text));
  return (await api.waitForSent(before + 1)).at(-1)?.text;
};

/** Sends `text` through the desktop app's local channel; the reply text. */
const ask = async (text: string, envelope: unknown) => {
  interpretations.set(text, envelope);
  const address = await anomander.localChannel;
  if (address === undefined) throw new Error('the local channel did not start');
  const socket = new WebSocket(`ws://${address.host}:${address.port}`, [
    LOCAL_CHANNEL_PROTOCOL,
    TOKEN,
  ]);
  try {
    const answer = new Promise<ChatEvent>((resolveEvent) => {
      socket.addEventListener('message', (message) => {
        const event: ChatEvent = JSON.parse(String(message.data));
        if (event.inReplyTo === 'q1') resolveEvent(event);
      });
    });
    await new Promise<void>((resolveOpen) => socket.addEventListener('open', () => resolveOpen()));
    socket.send(JSON.stringify({ type: 'text', text, id: 'q1' }));
    const event = await answer;
    return event.type === 'reply' ? event.text : JSON.stringify(event);
  } finally {
    socket.close();
  }
};

const THIS_MONTH = { kind: 'expense_query', from: '2026-11-01', to: '2026-11-24' };
const S90_THIS_MONTH = `Del 1 de noviembre al 24 de noviembre: ${eur('88,70')} en 4 gastos. Supermercado ${eur('57,70')} · Restaurantes ${eur('23,00')} · Sin clasificar ${eur('8,00')}. Pendientes de confirmar: 1.`;

describe('a free query on the expenses (R-30)', () => {
  it('AC2: totals the current expenses of the period by category, in one processor call, and stores the reply', async () => {
    const text = '¿cuánto llevo gastado este mes?';

    expect(await say(text, THIS_MONTH)).toBe(S90_THIS_MONTH);
    // AC6: interpreting is one AI call; computing makes none.
    expect(interpreterCalls).toBe(1);
    expect(query('SELECT sender, door, text FROM conversation ORDER BY id')).toEqual([
      { sender: 'principal', door: 'telegram', text },
      { sender: 'anomander', door: 'telegram', text: S90_THIS_MONTH },
    ]);
  });

  it('AC1: a period the processor ends after today ends today', async () => {
    expect(await say('¿cuánto llevo este mes?', { ...THIS_MONTH, to: '2026-11-30' })).toBe(
      S90_THIS_MONTH,
    );
  });

  it('AC3: a category lists the merchants with the most spent in it', async () => {
    expect(
      await say('¿cuánto llevo en supermercado este mes?', {
        ...THIS_MONTH,
        category: 'supermercado',
      }),
    ).toBe(
      `Del 1 de noviembre al 24 de noviembre, en supermercado: ${eur('57,70')} en 2 gastos. Mercadona ${eur('45,20')} · Lidl ${eur('12,50')}. Pendientes de confirmar: 1.`,
    );
  });

  it('AC3: a merchant counts only its expenses, as the principal wrote it', async () => {
    expect(
      await say('¿cuánto he gastado en mercadona este mes?', {
        ...THIS_MONTH,
        merchant: 'mercadona',
      }),
    ).toBe(
      `Del 1 de noviembre al 24 de noviembre, en mercadona: ${eur('45,20')} en 1 gasto. Supermercado ${eur('45,20')}. Pendientes de confirmar: 1.`,
    );
  });

  it('AC3: with a category, the merchants after the first 3 add up as one "Otros" amount', async () => {
    addRows([
      ['Dia', '2026-11-06', 1000, 'supermercado', 'current'],
      ['Carrefour', '2026-11-07', 500, 'supermercado', 'current'],
      [null, '2026-11-08', 200, 'supermercado', 'current'],
    ]);
    expect(
      await say('¿cuánto llevo en supermercado este mes?', {
        ...THIS_MONTH,
        category: 'supermercado',
      }),
    ).toBe(
      `Del 1 de noviembre al 24 de noviembre, en supermercado: ${eur('74,70')} en 5 gastos. Mercadona ${eur('45,20')} · Lidl ${eur('12,50')} · Dia ${eur('10,00')} · Otros ${eur('7,00')}. Pendientes de confirmar: 1.`,
    );
  });

  it('AC3: a merchant written without accents matches the accented one', async () => {
    addRows([['Cafetería Luna', '2026-11-05', 300, null, 'current']]);
    expect(
      await say('¿cuánto gasté en la cafeteria luna este mes?', {
        ...THIS_MONTH,
        merchant: 'cafeteria luna',
      }),
    ).toContain(eur('3,00'));
    // AC7: the merchant is still the principal's words when only the accents differ.
    expect(
      await say('¿cuánto gasté en la cafetería luna este mes?', {
        ...THIS_MONTH,
        merchant: 'cafeteria luna',
      }),
    ).toContain(eur('3,00'));
  });

  it('AC1: a period across years names its years', async () => {
    addRows([['Lidl', '2025-11-02', 10000, 'supermercado', 'current']]);
    expect(
      await say('¿cuánto he gastado desde noviembre del año pasado?', {
        kind: 'expense_query',
        from: '2025-11-01',
        to: '2026-11-24',
      }),
    ).toMatch(/^Del 1 de noviembre de 2025 al 24 de noviembre de 2026: /);
  });

  // B78 (assumption): a month named without a year is the latest one that is not in the future,
  // so "en diciembre" asked in November is last December, even if the processor said this one.
  it("B78: a whole month in the future that the principal named without a year is last year's", async () => {
    addRows([['Lidl', '2025-12-10', 1500, 'supermercado', 'current']]);
    expect(textInterpreterPrompt()).toContain(
      'A month named without a year is the latest one that is not after today: "en diciembre" asked in January is December of last year.',
    );
    expect(
      await say('¿cuánto gasté en diciembre?', {
        kind: 'expense_query',
        from: '2026-12-01',
        to: '2026-12-31',
      }),
    ).toBe(
      `Del 1 de diciembre de 2025 al 31 de diciembre de 2025: ${eur('15,00')} en 1 gasto. Supermercado ${eur('15,00')}.`,
    );
  });

  it('B78: a month in the future the principal named with its year is still refused', async () => {
    addRows([['Lidl', '2025-12-10', 1500, 'supermercado', 'current']]);
    logger.warn.mockClear();
    expect(
      await say('¿cuánto gasté en diciembre de 2026?', {
        kind: 'expense_query',
        from: '2026-12-01',
        to: '2026-12-31',
      }),
    ).toBe(S22);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('AC1: "en total" starts at the first expense', async () => {
    expect(
      await say('¿cuánto he gastado en total?', {
        kind: 'expense_query',
        from: null,
        to: '2026-11-24',
      }),
    ).toBe(
      `Del 30 de octubre al 24 de noviembre: ${eur('138,70')} en 5 gastos. Supermercado ${eur('107,70')} · Restaurantes ${eur('23,00')} · Sin clasificar ${eur('8,00')}. Pendientes de confirmar: 1.`,
    );
  });

  it('AC4: an expense pending confirmation is counted apart, never in the total', async () => {
    expect(
      await say('¿cuánto gasté el domingo?', {
        kind: 'expense_query',
        from: '2026-11-22',
        to: '2026-11-22',
      }),
    ).toBe('El 22 de noviembre no hay gastos. Pendientes de confirmar: 1.');
  });

  it('AC5: an empty period has its own sentence', async () => {
    expect(
      await say('¿cuánto gasté a principios de octubre?', {
        kind: 'expense_query',
        from: '2026-10-01',
        to: '2026-10-05',
      }),
    ).toBe('Del 1 de octubre al 5 de octubre no hay gastos.');
  });

  it('AC2: a figure the processor adds to its call is never used', async () => {
    expect(
      await say('¿cuánto llevo este mes? creo que unos 1000 €', {
        ...THIS_MONTH,
        total: 100000,
        count: 99,
        breakdown: [{ name: 'supermercado', cents: 100000 }],
      }),
    ).toBe(S90_THIS_MONTH);
  });

  it.each([
    ['a range in the future', { kind: 'expense_query', from: '2026-12-01', to: '2026-12-15' }],
    ['a category that does not exist', { ...THIS_MONTH, category: 'viajes' }],
    ['a date that does not exist', { kind: 'expense_query', from: '2026-02-30', to: '2026-03-01' }],
    [
      'a range that ends before it starts',
      { kind: 'expense_query', from: '2026-11-20', to: '2026-11-01' },
    ],
    ['a merchant the principal did not write', { ...THIS_MONTH, merchant: 'Lidl' }],
  ])('AC7: %s is answered S-22 and logged (R-22 AC1)', async (_case, envelope) => {
    logger.warn.mockClear();
    expect(await say('¿cuánto llevo en el súper?', envelope)).toBe(S22);
    expect(logger.warn).toHaveBeenCalled();
  });

  // DK-25 (B15): one currency per principal and no conversion, so a sum never adds two.
  it('DK-25: a period with expenses in two currencies says each sum apart, never added', async () => {
    const db = new Database(dbPath());
    db.prepare(
      `INSERT INTO expenses (merchant_id, occurred_on, total_cents, currency, category_id, mode, status, created_at)
       VALUES ((SELECT id FROM entities WHERE name = 'Mercadona'), '2026-11-05', 1200, 'USD',
               (SELECT id FROM categories WHERE name = 'supermercado'), 'declared', 'current', ?)`,
    ).run(NOW.toISOString());
    db.close();
    const usd = (amount: string) => `${amount}\u00a0US$`;

    expect(await say('¿cuánto llevo gastado este mes?', THIS_MONTH)).toBe(
      `Del 1 de noviembre al 24 de noviembre: ${eur('88,70')} y ${usd('12,00')} en 5 gastos. Supermercado ${eur('57,70')} y ${usd('12,00')} · Restaurantes ${eur('23,00')} · Sin clasificar ${eur('8,00')}. Pendientes de confirmar: 1.`,
    );
    expect(
      await say('¿cuánto llevo en supermercado este mes?', {
        ...THIS_MONTH,
        category: 'supermercado',
      }),
    ).toBe(
      `Del 1 de noviembre al 24 de noviembre, en supermercado: ${eur('57,70')} y ${usd('12,00')} en 3 gastos. Mercadona ${eur('45,20')} y ${usd('12,00')} · Lidl ${eur('12,50')}. Pendientes de confirmar: 1.`,
    );
  });

  // B74: the breakdown is ordered by the principal's currency first, so a category spent only in
  // US dollars comes after every category in euros, whatever its figure.
  it('DK-25: a category spent only in another currency is never ranked against euros by its figure', async () => {
    const db = new Database(dbPath());
    db.prepare("INSERT INTO categories (name, created_at) VALUES ('ocio', ?)").run(
      NOW.toISOString(),
    );
    db.prepare(
      `INSERT INTO expenses (occurred_on, total_cents, currency, category_id, mode, status, created_at)
       VALUES ('2026-11-05', 9000, 'USD', (SELECT id FROM categories WHERE name = 'ocio'),
               'declared', 'current', ?)`,
    ).run(NOW.toISOString());
    db.close();
    const usd = (amount: string) => `${amount} US$`;

    expect(await say('¿cuánto llevo gastado este mes?', THIS_MONTH)).toBe(
      `Del 1 de noviembre al 24 de noviembre: ${eur('88,70')} y ${usd('90,00')} en 5 gastos. Supermercado ${eur('57,70')} · Restaurantes ${eur('23,00')} · Ocio ${usd('90,00')} · Sin clasificar ${eur('8,00')}. Pendientes de confirmar: 1.`,
    );
  });

  it('AC8: the app gets the same answer, stored as a turn of its door', async () => {
    const text = '¿cuánto llevo gastado este mes?';

    expect(await ask(text, THIS_MONTH)).toBe(S90_THIS_MONTH);
    expect(query("SELECT sender, text FROM conversation WHERE door = 'app' ORDER BY id")).toEqual([
      { sender: 'principal', text },
      { sender: 'anomander', text: S90_THIS_MONTH },
    ]);
  });
});
