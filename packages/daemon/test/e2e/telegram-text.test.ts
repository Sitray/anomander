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
import { listMemories } from '../../src/store/memory.ts';

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
/** The user turns the text interpreter received, parsed. */
let interpreted: { recent: unknown; memories: unknown; message: string }[];
/** What the text interpreter answers, by message; the recorded expense when absent. */
let interpretations: Map<string, AssistantMessage>;
/** How many reply-phraser calls were made. */
let phrasings: number;

const complete = async (_model: string, context: Context) => {
  if (!processorAnswers) return new Promise<never>(() => {});
  const phrasing = context.systemPrompt === REPLY_PHRASER_PROMPT;
  if (phrasing) phrasings += 1;
  const [turn] = context.messages;
  let reply = recorded('expense-23-space-euro');
  if (!phrasing && turn?.role === 'user' && typeof turn.content === 'string') {
    const input = JSON.parse(turn.content);
    interpreted.push(input);
    reply = interpretations.get(input.message) ?? reply;
  }
  return phrasing ? { ...reply, content: [{ type: 'text' as const, text: PHRASED }] } : reply;
};

/** A conversation reply that also carries the declared fact "Es vegetariano" (R-23 AC1). */
const vegetarian = (reply: string): AssistantMessage => ({
  ...recorded('conversation'),
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        kind: 'conversation',
        reply,
        memories: [
          { text: 'Es vegetariano', quote: 'soy vegetariano', said: true, confidence: 0.95 },
        ],
      }),
    },
  ],
});

/** A recorded response whose JSON envelope is replaced, for cases no recording covers. */
const answering = (envelope: unknown): AssistantMessage => ({
  ...recorded('conversation'),
  content: [{ type: 'text', text: JSON.stringify(envelope) }],
});

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
  interpreted = [];
  interpretations = new Map();
  phrasings = 0;
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
    expect(reply?.payload.reply_markup).toBeUndefined();

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

  it('R-16 AC3: the interpreter receives the previous turn with the reply that was sent', async () => {
    api.push(updates.text({ chatId: PRINCIPAL }, '23 € cena'));
    await api.waitForSent(1);
    api.push(updates.text({ chatId: PRINCIPAL }, 'y otros 23 € cena'));
    await api.waitForSent(2);

    expect(interpreted.map(({ recent }) => recent)).toEqual([
      [],
      [{ principal: '23 € cena', reply: PHRASED }],
    ]);
  });

  it('R-23 AC1, AC2: a lasting fact said in conversation is remembered as declared', async () => {
    const reply = '¡Apuntado! Te propondré platos sin carne.';
    interpretations.set('soy vegetariano', vegetarian(reply));

    api.push(updates.text({ chatId: PRINCIPAL }, 'soy vegetariano'));
    const [sent] = await api.waitForSent(1);

    expect(sent?.text).toBe(reply);
    const db = new Database(join(scratch, 'anomander.db'), { readonly: true });
    try {
      expect(listMemories(db)).toEqual([
        { id: expect.any(Number), text: 'Es vegetariano', mode: 'declared' },
      ]);
    } finally {
      db.close();
    }
    expect(query("SELECT actor, source FROM assertions WHERE predicate = 'memory'")).toEqual([
      { actor: 'principal', source: expect.stringMatching(/^telegram:\d+$/) },
    ]);
    expect(query('SELECT id FROM expenses')).toEqual([]);
  });

  it('R-23 AC4: the next message is interpreted with the remembered facts', async () => {
    interpretations.set('soy vegetariano', vegetarian('Tomo nota.'));

    api.push(updates.text({ chatId: PRINCIPAL }, 'soy vegetariano'));
    await api.waitForSent(1);
    api.push(updates.text({ chatId: PRINCIPAL }, '¿qué ceno hoy?'));
    await api.waitForSent(2);

    expect(interpreted.map(({ memories }) => memories)).toEqual([
      [],
      [{ id: expect.any(Number), text: 'Es vegetariano', mode: 'declared' }],
    ]);
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

describe('conversation memory over Telegram (R-23 AC5, AC6)', () => {
  const say = async (text: string) => {
    const before = api.sent.length;
    api.push(updates.text({ chatId: PRINCIPAL }, text));
    return (await api.waitForSent(before + 1)).at(-1);
  };
  const press = async (question: { messageId: number }, data: string) => {
    const before = api.sent.length;
    api.push(updates.callbackQuery({ chatId: PRINCIPAL }, data, question.messageId));
    return (await api.waitForSent(before + 1)).at(-1);
  };
  const memories = () => {
    const db = new Database(join(scratch, 'anomander.db'), { readonly: true });
    try {
      return listMemories(db);
    } finally {
      db.close();
    }
  };
  /** Remembers "Es vegetariano" and returns its id. */
  const rememberVegetarian = async () => {
    interpretations.set('soy vegetariano', vegetarian('Tomo nota.'));
    await say('soy vegetariano');
    const [memory] = memories();
    if (memory === undefined) throw new Error('nothing remembered');
    return memory.id;
  };
  /** Asks to forget "Es vegetariano"; resolves with S-29 and its decision id. */
  const askToForget = async () => {
    const id = await rememberVegetarian();
    interpretations.set('olvida que soy vegetariano', answering({ kind: 'forget', ids: [id] }));
    const question = await say('olvida que soy vegetariano');
    await vi.waitFor(() =>
      expect(query('SELECT id FROM pending_decisions WHERE channel_ref IS NOT NULL')).toHaveLength(
        1,
      ),
    );
    const [decision] = query<{ id: number }>('SELECT id FROM pending_decisions');
    if (question === undefined || decision === undefined) throw new Error('no decision');
    return { question, decisionId: decision.id };
  };

  it('AC5: lists every current memory with its mode, or S-28 when there is none', async () => {
    interpretations.set('qué sabes de mí', answering({ kind: 'memory_list' }));

    const none = await say('qué sabes de mí');
    await rememberVegetarian();
    const some = await say('qué sabes de mí');

    expect(none?.text).toBe('Todavía no recuerdo nada de ti.');
    expect(some?.text).toBe('Esto es lo que recuerdo de ti:\n· Es vegetariano (me lo dijiste)');
  });

  it('AC6, R-16 AC3: "Sí" erases the memory and empties the recent turns', async () => {
    const { question, decisionId } = await askToForget();

    expect(question.text).toBe('¿Olvido esto?\n· Es vegetariano');
    expect(question.payload.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Sí', callback_data: `decision:${decisionId}:0` },
          { text: 'No', callback_data: `decision:${decisionId}:1` },
        ],
      ],
    });

    const done = await press(question, `decision:${decisionId}:0`);
    expect(done?.text).toBe('Hecho, lo he olvidado.');
    expect(memories()).toEqual([]);
    // The text is gone from every table; only the expired assertion marks it.
    expect(query('SELECT * FROM memory_texts')).toEqual([]);
    expect(query('SELECT question FROM pending_decisions')).toEqual([
      { question: '¿Olvido esto?' },
    ]);
    expect(query("SELECT status FROM assertions WHERE predicate = 'memory'")).toEqual([
      { status: 'expired' },
    ]);

    // The next interpretation sees neither the memory nor the turns that mentioned it.
    await say('¿qué ceno hoy?');
    const next = interpreted.at(-1);
    expect(next?.memories).toEqual([]);
    expect(next?.recent).toEqual([{ principal: '[botón: Sí]', reply: 'Hecho, lo he olvidado.' }]);
  });

  it('AC6: "No" erases nothing', async () => {
    const { question, decisionId } = await askToForget();

    const kept = await press(question, `decision:${decisionId}:1`);

    expect(kept?.text).toBe('Vale, no olvido nada.');
    expect(memories()).toEqual([
      { id: expect.any(Number), text: 'Es vegetariano', mode: 'declared' },
    ]);
  });

  it('AC6: asking to forget something not remembered gets S-32 and asks nothing', async () => {
    await rememberVegetarian();
    interpretations.set('olvida dónde vivo', answering({ kind: 'forget', ids: [] }));

    const reply = await say('olvida dónde vivo');

    expect(reply?.text).toBe('No encuentro nada así en lo que recuerdo.');
    expect(reply?.payload.reply_markup).toBeUndefined();
    expect(query('SELECT id FROM pending_decisions')).toEqual([]);
  });
});

describe('categories over Telegram (R-18)', () => {
  const S15 = '¿Creo la categoría «gasolina»?';
  const say = async (text: string) => {
    const before = api.sent.length;
    api.push(updates.text({ chatId: PRINCIPAL }, text));
    return (await api.waitForSent(before + 1)).at(-1);
  };
  const press = async (question: { messageId: number }, data: string) => {
    const before = api.sent.length;
    api.push(updates.callbackQuery({ chatId: PRINCIPAL }, data, question.messageId));
    return (await api.waitForSent(before + 1)).at(-1);
  };
  const yesNo = (decisionId: number) => ({
    inline_keyboard: [
      [
        { text: 'Sí', callback_data: `decision:${decisionId}:0` },
        { text: 'No', callback_data: `decision:${decisionId}:1` },
      ],
    ],
  });
  /** The one decision asked, once its message is recorded (R-17 AC2). */
  const askedDecision = async () => {
    await vi.waitFor(() =>
      expect(query('SELECT id FROM pending_decisions WHERE channel_ref IS NOT NULL')).toHaveLength(
        1,
      ),
    );
    const [decision] = query<{ id: number }>('SELECT id FROM pending_decisions');
    if (decision === undefined) throw new Error('no decision');
    return decision.id;
  };
  const categories = () => query<{ name: string }>('SELECT name FROM categories ORDER BY name');
  /** Asks to create "Gasolina"; resolves with S-15 and its decision id. */
  const askToCreate = async () => {
    interpretations.set(
      'crea la categoría Gasolina',
      answering({
        kind: 'category',
        name: 'Gasolina',
        reply: 'La categoría «gasolina» ya existe.',
      }),
    );
    const question = await say('crea la categoría Gasolina');
    const decisionId = await askedDecision();
    if (question === undefined) throw new Error('no question');
    return { question, decisionId };
  };

  it('AC1, AC2: "Sí" to S-15 creates the category in lowercase', async () => {
    const { question, decisionId } = await askToCreate();

    expect(question.text).toBe(S15);
    expect(question.payload.reply_markup).toEqual(yesNo(decisionId));
    expect(categories()).toEqual([{ name: 'restaurantes' }, { name: 'supermercado' }]);

    const done = await press(question, `decision:${decisionId}:0`);

    expect(done?.text).toBe('Hecho, he creado la categoría «gasolina».');
    expect(categories()).toEqual([
      { name: 'gasolina' },
      { name: 'restaurantes' },
      { name: 'supermercado' },
    ]);
    expect(
      query(`SELECT p.operation, p.status, d.status AS decision, x.authorized_by
             FROM proposals p JOIN pending_decisions d ON d.proposal_id = p.id
             JOIN actions x ON x.proposal_id = p.id`),
    ).toEqual([
      {
        operation: 'create_category',
        status: 'executed',
        decision: 'answered',
        authorized_by: 'principal',
      },
    ]);
  });

  it('AC1: "No" to S-15 replies S-34 and creates nothing', async () => {
    const { question, decisionId } = await askToCreate();

    const kept = await press(question, `decision:${decisionId}:1`);

    expect(kept?.text).toBe('Vale, no la creo.');
    expect(categories()).toEqual([{ name: 'restaurantes' }, { name: 'supermercado' }]);
    expect(
      query(`SELECT p.status, d.status AS decision FROM proposals p
             JOIN pending_decisions d ON d.proposal_id = p.id`),
    ).toEqual([{ status: 'rejected', decision: 'answered' }]);
    expect(query('SELECT id FROM actions')).toEqual([]);
  });

  it('AC1, R-21: an existing category gets S-36 phrased in the same call, or verbatim', async () => {
    const phrased = 'Ya tienes la categoría supermercado, no hace falta crearla.';
    interpretations.set(
      'crea la categoría supermercado',
      answering({ kind: 'category', name: 'supermercado', reply: phrased }),
    );
    // The phrasing drops the name, so it fails the R-21 AC2 check.
    interpretations.set(
      'crea la categoría Supermercado',
      answering({ kind: 'category', name: 'Supermercado', reply: 'Esa ya la tienes.' }),
    );

    const kept = await say('crea la categoría supermercado');
    const verbatim = await say('crea la categoría Supermercado');

    expect(kept?.text).toBe(phrased);
    expect(kept?.payload.reply_markup).toBeUndefined();
    expect(verbatim?.text).toBe('La categoría «supermercado» ya existe.');
    expect(verbatim?.payload.reply_markup).toBeUndefined();
    expect(phrasings).toBe(0);
    expect(query('SELECT id FROM proposals')).toEqual([]);
    expect(categories()).toEqual([{ name: 'restaurantes' }, { name: 'supermercado' }]);
  });

  it('AC1, R-5 AC3: a name the principal did not write is not proposed', async () => {
    interpretations.set(
      'crea una categoría para el coche',
      answering({
        kind: 'category',
        name: 'gasolina',
        reply: 'La categoría «gasolina» ya existe.',
      }),
    );

    const reply = await say('crea una categoría para el coche');

    expect(reply?.text).toBe('No tengo claro el importe. ¿Me lo escribes? Por ejemplo: 23,40');
    expect(reply?.payload.reply_markup).toBeUndefined();
    expect(query('SELECT id FROM proposals')).toEqual([]);
    expect(categories()).toEqual([{ name: 'restaurantes' }, { name: 'supermercado' }]);
  });

  it('AC3: a stated category that does not exist registers uncategorized; "Sí" assigns it as declared', async () => {
    const text = '40 € gasolina, categoría gasolina';
    interpretations.set(
      text,
      answering({
        kind: 'expense',
        inferences: [
          {
            subject_type: 'expense',
            subject_id: null,
            predicate: 'total',
            value_json: 4000,
            mode: 'inferred',
            basis_json: { quote: '40 €' },
            confidence: 0.98,
          },
          {
            subject_type: 'expense',
            subject_id: null,
            predicate: 'declared_category',
            value_json: 'gasolina',
            mode: 'inferred',
            basis_json: { quote: 'categoría gasolina' },
            confidence: 0.95,
          },
        ],
      }),
    );

    const question = await say(text);
    const decisionId = await askedDecision();

    // S-2 (the phrasing fails the check, so it is verbatim), then S-15 with its buttons.
    expect(question?.text).toBe(`Apuntado: 40,00 € (sin clasificar).\n${S15}`);
    expect(question?.payload.reply_markup).toEqual(yesNo(decisionId));
    expect(query('SELECT total_cents, category_id, category_basis, status FROM expenses')).toEqual([
      { total_cents: 4000, category_id: null, category_basis: null, status: 'current' },
    ]);
    // R-9 AC2: the delivery of the expense reply verifies its action.
    await vi.waitFor(() =>
      expect(
        query(`SELECT a.value_json FROM actions x
               JOIN assertions a ON a.id = x.verification_assertion_id`),
      ).toEqual([{ value_json: JSON.stringify({ text: 'Apuntado: 40,00 € (sin clasificar).' }) }]),
    );
    if (question === undefined) throw new Error('no question');

    const done = await press(question, `decision:${decisionId}:0`);

    expect(done?.text).toBe('Hecho, he creado la categoría «gasolina».');
    expect(
      query(`SELECT c.name, e.category_basis FROM expenses e
             JOIN categories c ON c.id = e.category_id`),
    ).toEqual([{ name: 'gasolina', category_basis: 'declared' }]);
    expect(
      query(`SELECT predicate, value_json, mode, actor, status FROM assertions
             WHERE subject_type = 'expense' AND predicate = 'category'`),
    ).toEqual([
      {
        predicate: 'category',
        value_json: '"gasolina"',
        mode: 'declared',
        actor: 'principal',
        status: 'current',
      },
    ]);
    expect(query("SELECT status FROM proposals WHERE operation = 'create_category'")).toEqual([
      { status: 'executed' },
    ]);
  });
});
