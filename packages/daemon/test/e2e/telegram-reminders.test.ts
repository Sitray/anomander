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
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { TEXT_INTERPRETER_PROMPT } from '../../src/processor/text-interpreter.ts';

// End to end (PRD §15): reminders and tasks (R-25 AC1-AC6, AC8-AC10, AC12), the first capability
// (R-24), through the fake Telegram API, the real bot and a SQLite file.
const PRINCIPAL = 4242;
const principal = { chatId: PRINCIPAL };
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const recorded = (name: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));
// Friday 30 October 2026, 11:00 in Madrid.
const NOW = new Date('2026-10-30T10:00:05.000Z');
const S22 =
  'Algo ha fallado y no he podido procesar tu mensaje. ¿Me lo vuelves a enviar en un rato?';

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };
/** What the text interpreter answers, by message. */
let interpretations: Map<string, AssistantMessage>;
/** The user turns the text interpreter received, parsed. */
let turns: Record<string, unknown>[];

/** A recorded response whose JSON envelope is replaced. */
const answering = (envelope: unknown): AssistantMessage => ({
  ...recorded('text-interpreter/conversation'),
  content: [{ type: 'text', text: JSON.stringify(envelope) }],
});

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-reminders-'));
  interpretations = new Map();
  turns = [];
  api = await startFakeTelegramApi();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o',
    TZ: 'Europe/Madrid',
  });
  const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
    const [turn] = context.messages;
    if (context.systemPrompt === TEXT_INTERPRETER_PROMPT && typeof turn?.content === 'string') {
      const parsed = JSON.parse(turn.content);
      turns.push(parsed);
      const interpretation = interpretations.get(parsed.message);
      if (interpretation === undefined) throw new Error(`no interpretation for ${parsed.message}`);
      return interpretation;
    }
    return { ...answering({}), content: [], stopReason: 'error', errorMessage: 'offline' };
  };
  logger = { info: vi.fn<Log>(), warn: vi.fn<Log>(), error: vi.fn<Log>() };
  anomander = startAnomander(config, {
    complete,
    model: 'openai/gpt-4o-mini',
    visionModel: 'openai/gpt-4o',
    telegramApiRoot: api.apiRoot,
    logger,
    now: () => NOW,
  });
  await anomander.started;
});

afterEach(async () => {
  await anomander.stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

const query = <T>(sql: string): T[] => {
  const db = new Database(join(scratch, 'anomander.db'));
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

/** Sends `text` with the interpreter answering `envelope`; resolves with the reply text. */
const say = async (text: string, envelope: unknown) => {
  interpretations.set(text, answering(envelope));
  const before = api.sent.length;
  api.push(updates.text(principal, text));
  return (await api.waitForSent(before + 1)).at(-1)?.text;
};

const create = (fields: Record<string, unknown>) => ({
  kind: 'reminder_create',
  at: null,
  recurrence: null,
  unsupported_recurrence: false,
  ...fields,
});

const reminders = () =>
  query('SELECT text, due_at, recurrence_json, status, closed_at FROM reminders ORDER BY id');
const reminderAssertions = () =>
  query("SELECT id FROM assertions WHERE subject_type = 'reminder' OR predicate = 'reminder'");
/** R-25 AC12: everything logged, to check no reminder text is in it. */
const logged = () =>
  JSON.stringify([
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
  ]);

describe('creating reminders and tasks over Telegram (R-25)', () => {
  it('AC2, AC6: a one-time reminder is stored at once with a declared assertion and S-40 phrased', async () => {
    const reply = await say(
      'recuérdame mañana llamar a mamá',
      create({
        text: 'llamar a mamá',
        at: '2026-10-31T09:00',
        reply: '¡Claro! Te lo recuerdo mañana a las 9:00: llamar a mamá.',
      }),
    );

    expect(reply).toBe('¡Claro! Te lo recuerdo mañana a las 9:00: llamar a mamá.');
    expect(reminders()).toEqual([
      {
        text: 'llamar a mamá',
        due_at: '2026-10-31T08:00:00.000Z',
        recurrence_json: null,
        status: 'pending',
        closed_at: null,
      },
    ]);
    expect(
      query(`SELECT a.subject_type, a.subject_id = r.id AS about_it, a.predicate, a.mode, a.actor,
               a.source, a.status
             FROM reminders r JOIN assertions a ON a.id = r.declared_by_assertion_id`),
    ).toEqual([
      {
        subject_type: 'reminder',
        about_it: 1,
        predicate: 'reminder',
        mode: 'declared',
        actor: 'principal',
        source: expect.stringMatching(/^telegram:\d+$/),
        status: 'current',
      },
    ]);
  });

  it('AC6, R-21 AC2: a phrased S-40 with a wrong fact falls back to the verbatim string, and logs no text (AC12)', async () => {
    const reply = await say(
      'recuérdame mañana llamar a mamá',
      create({
        text: 'llamar a mamá',
        at: '2026-10-31T09:00',
        reply: 'Te lo recuerdo mañana a las 10:00: llamar a mamá.',
      }),
    );

    expect(reply).toBe('Te lo recuerdo mañana a las 9:00: llamar a mamá.');
    expect(logged()).not.toContain('mamá');
  });

  it('AC3: a weekly reminder is stored with its recurrence and its first occurrence after now', async () => {
    const reply = await say(
      'recuérdame los lunes y jueves a las 8 sacar la basura',
      create({
        text: 'sacar la basura',
        recurrence: { freq: 'weekly', days: [4, 1], time: '08:00' },
      }),
    );

    expect(reply).toBe('Te lo recuerdo todos los lunes y jueves a las 8:00: sacar la basura.');
    expect(reminders()).toEqual([
      {
        text: 'sacar la basura',
        due_at: '2026-11-02T07:00:00.000Z',
        recurrence_json: '{"freq":"weekly","days":[1,4],"time":"08:00"}',
        status: 'pending',
        closed_at: null,
      },
    ]);
  });

  it('R-24 AC2: small format slips in a reminder call are read as meant, not rejected', async () => {
    const once = await say(
      'recuérdame mañana llamar a mamá',
      create({ text: 'llamar a mamá', at: '2026-10-31T9:00:00', reply: '' }),
    );
    const weekly = await say(
      'recuérdame los lunes a las 8 sacar la basura',
      create({
        text: 'sacar la basura',
        recurrence: { freq: 'weekly', days: [1], time: '8:00' },
        reply: null,
      }),
    );

    expect(once).toBe('Te lo recuerdo mañana a las 9:00: llamar a mamá.');
    expect(weekly).toBe('Te lo recuerdo todos los lunes a las 8:00: sacar la basura.');
    expect(reminders()).toMatchObject([
      { due_at: '2026-10-31T08:00:00.000Z', recurrence_json: null },
      {
        due_at: '2026-11-02T07:00:00.000Z',
        recurrence_json: '{"freq":"weekly","days":[1],"time":"08:00"}',
      },
    ]);
  });

  it('AC3: a repetition it cannot keep gets S-51 and stores nothing', async () => {
    const reply = await say(
      'recuérdame cada dos semanas regar las plantas',
      create({ text: 'regar las plantas', unsupported_recurrence: true }),
    );

    expect(reply).toBe(
      'Todavía no sé repetir recordatorios así. Puedo cada día, cada semana o cada mes.',
    );
    expect(reminders()).toEqual([]);
    expect(reminderAssertions()).toEqual([]);
  });

  it('AC4: a time that has already passed gets S-52 and stores nothing', async () => {
    const reply = await say(
      'recuérdame hoy a las 8 tomar la pastilla',
      create({ text: 'tomar la pastilla', at: '2026-10-30T08:00' }),
    );

    expect(reply).toBe('Esa hora ya pasó. ¿Para cuándo lo quieres?');
    expect(reminders()).toEqual([]);
    expect(reminderAssertions()).toEqual([]);
  });

  it('AC2: a text that is not in the message is not stored; the reply is S-22 and logs no text', async () => {
    const reply = await say(
      'recuérdame mañana lo de mamá',
      create({ text: 'llamar a mamá', at: '2026-10-31T09:00' }),
    );

    expect(reply).toBe(S22);
    expect(reminders()).toEqual([]);
    expect(reminderAssertions()).toEqual([]);
    expect(logged()).not.toContain('mamá');
  });

  it('R-24 AC2: a reminder call that does not match its schema is handled as R-22 AC1', async () => {
    const reply = await say(
      'recuérdame mañana llamar a mamá',
      create({ text: 'llamar a mamá', at: 'mañana a las 9' }),
    );

    expect(reply).toBe(S22);
    expect(reminders()).toEqual([]);
  });

  it('AC5: a task with no date is stored without a time and gets S-41', async () => {
    const reply = await say('tengo que comprar pilas', create({ text: 'comprar pilas' }));

    expect(reply).toBe('Apuntado en tus pendientes: comprar pilas.');
    expect(reminders()).toEqual([
      {
        text: 'comprar pilas',
        due_at: null,
        recurrence_json: null,
        status: 'pending',
        closed_at: null,
      },
    ]);
  });

  it('AC1, R-24 AC4: the interpreter receives the time in TZ and what is pending; conversation still replies', async () => {
    await say('tengo que comprar pilas', create({ text: 'comprar pilas' }));
    await say(
      'recuérdame mañana llamar a mamá',
      create({ text: 'llamar a mamá', at: '2026-10-31T09:00' }),
    );

    const reply = await say('hola', { kind: 'conversation', reply: '¡Hola! ¿Qué tal?' });

    expect(reply).toBe('¡Hola! ¿Qué tal?');
    expect(turns.at(-1)).toMatchObject({
      today: '2026-10-30',
      reminders: {
        now: '2026-10-30T11:00',
        weekday: 'Friday',
        pending: [
          { id: 2, text: 'llamar a mamá', when: 'mañana a las 9:00' },
          { id: 1, text: 'comprar pilas', when: null },
        ],
      },
      message: 'hola',
    });
  });
});

describe('listing, cancelling and finishing reminders and tasks over Telegram (R-25)', () => {
  /** Presses option `index` of the only decision once its question is recorded; the reply text. */
  const press = async (index: number) => {
    await vi.waitFor(() =>
      expect(query('SELECT id FROM pending_decisions WHERE channel_ref IS NOT NULL')).toHaveLength(
        1,
      ),
    );
    const [decision] = query<{ id: number }>('SELECT id FROM pending_decisions');
    const question = api.sent.at(-1);
    const before = api.sent.length;
    const data = `decision:${decision?.id}:${index}`;
    api.push(updates.callbackQuery(principal, data, question?.messageId ?? 0));
    return (await api.waitForSent(before + 1)).at(-1)?.text;
  };
  const statuses = () =>
    query(`SELECT r.status, r.closed_at IS NOT NULL AS closed, a.status AS assertion
           FROM reminders r JOIN assertions a ON a.id = r.declared_by_assertion_id ORDER BY r.id`);
  const addTask = (text: string) => say(`tengo que ${text}`, create({ text }));

  it('AC8: code lists pending reminders soonest first, then tasks oldest first, or S-45', async () => {
    const none = await say('¿qué tengo pendiente?', { kind: 'reminder_list' });
    await addTask('comprar pilas');
    await say(
      'recuérdame mañana llamar a mamá',
      create({ text: 'llamar a mamá', at: '2026-10-31T09:00' }),
    );
    await addTask('pagar la luz');
    await say(
      'recuérdame hoy a las 18 sacar la basura',
      create({ text: 'sacar la basura', at: '2026-10-30T18:00' }),
    );

    const some = await say('¿qué tengo pendiente?', { kind: 'reminder_list' });

    expect(none).toBe('No tienes nada pendiente.');
    expect(some).toBe(
      [
        'Esto tienes pendiente:',
        '· sacar la basura (hoy a las 18:00)',
        '· llamar a mamá (mañana a las 9:00)',
        '· comprar pilas',
        '· pagar la luz',
      ].join('\n'),
    );
  });

  it('AC9: "Sí" to S-46 cancels the picked pending items and expires their assertions', async () => {
    await addTask('comprar pilas');
    await addTask('pagar la luz');

    const question = await say('cancela lo de las pilas', {
      kind: 'reminder_cancel',
      ids: [1, 99],
    });
    expect(question).toBe('¿Cancelo esto?\n· comprar pilas');
    expect(api.sent.at(-1)?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Sí', callback_data: expect.stringMatching(/^decision:\d+:0$/) },
          { text: 'No', callback_data: expect.stringMatching(/^decision:\d+:1$/) },
        ],
      ],
    });

    expect(await press(0)).toBe('Hecho, cancelado.');
    expect(statuses()).toEqual([
      { status: 'cancelled', closed: 1, assertion: 'expired' },
      { status: 'pending', closed: 0, assertion: 'current' },
    ]);
    // Only the S-46 header is stored with the decision; the texts stay in `reminders`.
    expect(query('SELECT question FROM pending_decisions')).toEqual([
      { question: '¿Cancelo esto?' },
    ]);
    expect(logged()).not.toContain('pilas');
  });

  it('AC9: "No" to S-46 changes nothing', async () => {
    await addTask('comprar pilas');
    await say('cancela lo de las pilas', { kind: 'reminder_cancel', ids: [1] });

    expect(await press(1)).toBe('Vale, no cancelo nada.');
    expect(statuses()).toEqual([{ status: 'pending', closed: 0, assertion: 'current' }]);
  });

  it('AC9, AC10: nothing matching gets S-49, asks nothing and changes nothing', async () => {
    await addTask('comprar pilas');

    const cancel = await say('cancela lo del dentista', { kind: 'reminder_cancel', ids: [] });
    const done = await say('ya fui al dentista', { kind: 'reminder_done', ids: [7] });

    expect(cancel).toBe('No encuentro nada así en tus pendientes.');
    expect(done).toBe('No encuentro nada así en tus pendientes.');
    expect(query('SELECT id FROM pending_decisions')).toEqual([]);
    expect(statuses()).toEqual([{ status: 'pending', closed: 0, assertion: 'current' }]);
  });

  it('AC10: the picked pending items are done at once and kept; S-50 joins their texts', async () => {
    await addTask('comprar pilas');
    await addTask('pagar la luz');
    await addTask('regar las plantas');
    await say(
      'recuérdame mañana llamar a mamá',
      create({ text: 'llamar a mamá', at: '2026-10-31T09:00' }),
    );

    const reply = await say('ya he hecho todo menos regar', {
      kind: 'reminder_done',
      ids: [1, 2, 4],
    });

    expect(reply).toBe('Hecho: llamar a mamá, comprar pilas y pagar la luz.');
    expect(api.sent.at(-1)?.payload.reply_markup).toBeUndefined();
    expect(statuses()).toEqual([
      { status: 'done', closed: 1, assertion: 'current' },
      { status: 'done', closed: 1, assertion: 'current' },
      { status: 'pending', closed: 0, assertion: 'current' },
      { status: 'done', closed: 1, assertion: 'current' },
    ]);
    expect(logged()).not.toContain('pilas');
  });

  it('AC5: giving a pending task a time turns that same row into a reminder, S-40', async () => {
    await addTask('comprar pilas');

    const reply = await say(
      'lo de las pilas, recuérdamelo el sábado',
      create({ id: 1, text: 'comprar pilas', at: '2026-10-31T09:00' }),
    );

    expect(reply).toBe('Te lo recuerdo mañana a las 9:00: comprar pilas.');
    expect(reminders()).toEqual([
      {
        text: 'comprar pilas',
        due_at: '2026-10-31T08:00:00.000Z',
        recurrence_json: null,
        status: 'pending',
        closed_at: null,
      },
    ]);
    expect(reminderAssertions()).toHaveLength(1);
  });
});
