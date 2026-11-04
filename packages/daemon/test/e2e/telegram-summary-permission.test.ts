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
import { weeklySummaryCapability } from '../../src/summary/capability.ts';

// End to end (PRD §15): turning the weekly summary on and off (R-10 AC5-AC7), the third
// capability (R-24), through the fake Telegram API, the real bot and a SQLite file. Once it is
// on, the summary goes out at its cron.
const PRINCIPAL = 4242;
const principal = { chatId: PRINCIPAL };
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const recorded = (name: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));
// Sunday 1 November 2026, 20:00 in Madrid.
const NOW = new Date('2026-11-01T19:00:00.000Z');
const S74 = '¿Te mando cada semana un resumen de tus gastos?';

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

/** Starts the daemon; `cron` is the summary's schedule. */
const start = async (cron = '0 20 * * 0') => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o',
    ANOMANDER_WEEKLY_SUMMARY_CRON: cron,
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
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-summary-permission-'));
  interpretations = new Map();
  api = await startFakeTelegramApi();
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
     WHERE operation = 'send_weekly_summary' ORDER BY id`,
  );

const ENABLE = { kind: 'weekly_summary_enable' };
const DISABLE = { kind: 'weekly_summary_disable' };

describe('turning the weekly summary on and off over Telegram (R-10)', () => {
  it('AC5, AC6: off by default; "Sí" to S-74 grants it, S-75, and S-9 then goes out at its cron', async () => {
    // Every second, so the test does not wait for Sunday.
    await start('* * * * * *');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // AC5: nothing is sent while it is off.
    expect(api.sent).toEqual([]);

    expect(await say('mándame el resumen semanal', ENABLE)).toBe(S74);
    expect(api.sent.at(-1)?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Sí', callback_data: expect.stringMatching(/^decision:\d+:0$/) },
          { text: 'No', callback_data: expect.stringMatching(/^decision:\d+:1$/) },
        ],
      ],
    });
    expect(permissions()).toEqual([]);

    expect(await press(0)).toBe('Hecho: te mando el resumen de tus gastos cada semana.');
    expect(permissions()).toEqual([{ conditions_json: '{}', revoked: 0 }]);
    expect(
      query(
        'SELECT p.operation, a.authorized_by FROM actions a JOIN proposals p ON p.id = a.proposal_id',
      ),
    ).toEqual([{ operation: 'grant_weekly_summary', authorized_by: 'principal' }]);

    const before = api.sent.length;
    expect((await api.waitForSent(before + 1)).at(-1)?.text).toMatch(
      /^Semana del 26 de octubre al 1 de noviembre: /,
    );
  });

  it('AC6: "No" grants nothing, S-55; once on, asking again replies S-76 and asks nothing', async () => {
    await start();
    await say('mándame el resumen semanal', ENABLE);
    expect(await press(1)).toBe('Vale, no te lo mando.');
    expect(permissions()).toEqual([]);

    await say('mándame el resumen semanal', ENABLE);
    await press(0);
    const decisions = query('SELECT id FROM pending_decisions').length;
    expect(await say('quiero el resumen de la semana', ENABLE)).toBe(
      'Ya te mando el resumen de tus gastos cada semana.',
    );
    expect(query('SELECT id FROM pending_decisions')).toHaveLength(decisions);
  });

  it('AC6: a new S-74 closes the earlier unanswered one, whose "Sí" then grants nothing (S-19)', async () => {
    await start();
    await say('mándame el resumen semanal', ENABLE);
    const first = api.sent.at(-1);
    await say('mándame el resumen de gastos de la semana', ENABLE);

    expect(query('SELECT status FROM pending_decisions ORDER BY id')).toEqual([
      { status: 'expired' },
      { status: 'open' },
    ]);
    const [stale] = query<{ id: number }>('SELECT id FROM pending_decisions ORDER BY id');
    const before = api.sent.length;
    api.push(updates.callbackQuery(principal, `decision:${stale?.id}:0`, first?.messageId ?? 0));
    expect((await api.waitForSent(before + 1)).at(-1)?.text).toBe(
      'Esa pregunta ya no está abierta.',
    );
    expect(permissions()).toEqual([]);
  });

  it('AC7: turning it off revokes the permission at once, S-77, or replies S-78 when it is off', async () => {
    await start();
    await say('mándame el resumen semanal', ENABLE);
    await press(0);

    expect(await say('deja de mandarme el resumen semanal', DISABLE)).toBe(
      'Hecho, ya no te mando el resumen semanal.',
    );
    expect(permissions()).toEqual([{ conditions_json: '{}', revoked: 1 }]);
    expect(await say('deja de mandarme el resumen semanal', DISABLE)).toBe(
      'No tenía activado el resumen semanal.',
    );
  });

  it('R-24 AC1, AC8: the prompt holds the digest section, then the weekly summary section', () => {
    const digest = TEXT_INTERPRETER_PROMPT.indexOf(digestCapability.prompt);
    expect(digest).toBeGreaterThan(0);
    expect(TEXT_INTERPRETER_PROMPT.indexOf(weeklySummaryCapability.prompt)).toBeGreaterThan(digest);
    expect(weeklySummaryCapability.prompt).toContain(
      'a summary with no such word is the morning summary',
    );
  });
});
