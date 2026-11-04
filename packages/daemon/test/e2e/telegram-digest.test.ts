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
import { digestCapability } from '../../src/digest/capability.ts';
import { TEXT_INTERPRETER_PROMPT } from '../../src/processor/text-interpreter.ts';
import { remindersCapability } from '../../src/reminders/capability.ts';

// End to end (PRD §15): turning the morning digest on, changing its time and turning it off
// (R-26 AC1-AC4), the second capability (R-24), through the fake Telegram API, the real bot and a
// SQLite file.
const PRINCIPAL = 4242;
const principal = { chatId: PRINCIPAL };
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const recorded = (name: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));
// Friday 30 October 2026, 11:00 in Madrid.
const NOW = new Date('2026-10-30T10:00:05.000Z');
const S53 = (hora: string) =>
  `¿Te mando cada mañana a las ${hora} un resumen con tus recordatorios del día, tus pendientes y los gastos por confirmar?`;

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander;
/** What the text interpreter answers, by message. */
let interpretations: Map<string, AssistantMessage>;

/** A recorded response whose JSON envelope is replaced. */
const answering = (envelope: unknown): AssistantMessage => ({
  ...recorded('text-interpreter/conversation'),
  content: [{ type: 'text', text: JSON.stringify(envelope) }],
});

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-digest-'));
  interpretations = new Map();
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
      const { message } = JSON.parse(turn.content);
      const interpretation = interpretations.get(message);
      if (interpretation === undefined) throw new Error(`no interpretation for ${message}`);
      return interpretation;
    }
    return { ...answering({}), content: [], stopReason: 'error', errorMessage: 'offline' };
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

/** Presses option `index` of the latest decision once its question is recorded; the reply text. */
const press = async (index: number) => {
  await vi.waitFor(() =>
    expect(
      query("SELECT id FROM pending_decisions WHERE channel_ref IS NOT NULL AND status = 'open'"),
    ).toHaveLength(1),
  );
  const [decision] = query<{ id: number }>(
    "SELECT id FROM pending_decisions WHERE status = 'open'",
  );
  const question = api.sent.at(-1);
  const before = api.sent.length;
  api.push(
    updates.callbackQuery(principal, `decision:${decision?.id}:${index}`, question?.messageId ?? 0),
  );
  return (await api.waitForSent(before + 1)).at(-1)?.text;
};

const permissions = () =>
  query(
    `SELECT conditions_json, revoked_at IS NOT NULL AS revoked FROM permissions
     WHERE operation = 'send_morning_digest' ORDER BY id`,
  );

const enable = (time: string | null) => ({ kind: 'digest_enable', time });

describe('turning the morning digest on and off over Telegram (R-26)', () => {
  it('AC1, AC2: asks S-53 with Sí and No, and "Sí" grants the permission the principal authorized, S-54', async () => {
    const question = await say('mándame un resumen cada mañana a las 7:30', enable('07:30'));

    expect(question).toBe(S53('7:30'));
    expect(api.sent.at(-1)?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Sí', callback_data: expect.stringMatching(/^decision:\d+:0$/) },
          { text: 'No', callback_data: expect.stringMatching(/^decision:\d+:1$/) },
        ],
      ],
    });
    // §8.1: nothing is granted until the principal answers.
    expect(permissions()).toEqual([]);

    expect(await press(0)).toBe('Hecho: te lo mando cada mañana a las 7:30.');
    expect(permissions()).toEqual([{ conditions_json: '{"time":"07:30"}', revoked: 0 }]);
    expect(
      query(
        'SELECT p.operation, a.authorized_by FROM actions a JOIN proposals p ON p.id = a.proposal_id',
      ),
    ).toEqual([{ operation: 'grant_morning_digest', authorized_by: 'principal' }]);
  });

  it('AC1, AC2: without a time it asks for 8:00, and "No" grants nothing, S-55', async () => {
    expect(await say('mándame un resumen cada mañana', enable(null))).toBe(S53('8:00'));

    expect(await press(1)).toBe('Vale, no te lo mando.');
    expect(permissions()).toEqual([]);
  });

  it('AC3: another time asks S-53 again and replaces the earlier permission; the same time replies S-59', async () => {
    await say('mándame un resumen cada mañana a las 7:30', enable('07:30'));
    await press(0);

    expect(await say('pásame el resumen a las 9', enable('9:00'))).toBe(S53('9:00'));
    // Until "Sí", the authorized time stays the one in force.
    expect(permissions()).toEqual([{ conditions_json: '{"time":"07:30"}', revoked: 0 }]);
    expect(await press(0)).toBe('Hecho: te lo mando cada mañana a las 9:00.');
    expect(permissions()).toEqual([
      { conditions_json: '{"time":"07:30"}', revoked: 1 },
      { conditions_json: '{"time":"09:00"}', revoked: 0 },
    ]);

    const decisions = query('SELECT id FROM pending_decisions').length;
    expect(await say('mándamelo a las 9', enable('09:00'))).toBe(
      'Ya te lo mando cada mañana a las 9:00.',
    );
    expect(query('SELECT id FROM pending_decisions')).toHaveLength(decisions);
  });

  it('AC4: turning it off revokes the permission at once, S-56, or replies S-58 when none is active', async () => {
    await say('mándame un resumen cada mañana a la 1', enable('01:00'));
    expect(api.sent.at(-1)?.text).toBe(
      '¿Te mando cada mañana a la 1:00 un resumen con tus recordatorios del día, tus pendientes y los gastos por confirmar?',
    );
    await press(0);

    expect(await say('deja de mandarme el resumen', { kind: 'digest_disable' })).toBe(
      'Hecho, ya no te mando el resumen de la mañana.',
    );
    expect(permissions()).toEqual([{ conditions_json: '{"time":"01:00"}', revoked: 1 }]);
    expect(await say('deja de mandarme el resumen', { kind: 'digest_disable' })).toBe(
      'No tenía activado el resumen de la mañana.',
    );
  });

  it('R-24 AC1: the prompt holds the reminders section unchanged, then the digest section', () => {
    const reminders = TEXT_INTERPRETER_PROMPT.indexOf(remindersCapability.prompt);
    expect(reminders).toBeGreaterThan(0);
    expect(TEXT_INTERPRETER_PROMPT.indexOf(digestCapability.prompt)).toBeGreaterThan(reminders);
  });
});
