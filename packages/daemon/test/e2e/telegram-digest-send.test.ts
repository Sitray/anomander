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
import type { Recurrence } from '../../src/reminders/when.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { createReminder } from '../../src/store/reminders.ts';

// End to end (PRD §15): the morning digest reaches the principal unasked (R-26 AC5-AC7, R-16 AC3)
// over the fake Telegram API, from the scheduler's startup run. A restart runs the same job as the
// every-minute tick, so it stands in for a later minute. The digest runs just before due
// reminders, so a reminder due at the start shows that the digest job has run.
const PRINCIPAL = 4242;
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
// Friday 30 October 2026 in Madrid (UTC+1).
const AT_0730 = new Date('2026-10-30T06:30:05.000Z');

let scratch: string;
let dbPath: string;
let api: FakeTelegramApi;
let anomander: Anomander | undefined;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };
/** The user turns the text interpreter received, parsed. */
let turns: Record<string, unknown>[];

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-digest-send-'));
  dbPath = join(scratch, 'anomander.db');
  const db = openDatabase(dbPath);
  applyMigrations(db);
  db.close();
  api = await startFakeTelegramApi();
  logger = { info: vi.fn<Log>(), warn: vi.fn<Log>(), error: vi.fn<Log>() };
  turns = [];
});

afterEach(async () => {
  await anomander?.stop();
  anomander = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** The processor answers only conversation; the digest itself must never call it (AC5). */
const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
  const [turn] = context.messages;
  if (typeof turn?.content !== 'string') throw new Error('the processor must not be called');
  turns.push(JSON.parse(turn.content));
  return JSON.parse(readFileSync(resolve(FIXTURES, 'text-interpreter/conversation.json'), 'utf8'));
};

/** Starts the daemon on the seeded store with the clock at `at`. */
const start = async (at: Date) => {
  await anomander?.stop();
  anomander = startAnomander(
    loadConfig({
      TELEGRAM_BOT_TOKEN: api.token,
      ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
      ANOMANDER_DB_PATH: dbPath,
      ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
      ANOMANDER_MODEL: 'openai/gpt-4o-mini',
      ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
      TZ: 'Europe/Madrid',
    }),
    { complete, model: 'openai/gpt-4o-mini', telegramApiRoot: api.apiRoot, logger, now: () => at },
  );
  await anomander.started;
};

const run = <T>(work: (db: Database.Database) => T): T => {
  const db = new Database(dbPath);
  try {
    return work(db);
  } finally {
    db.close();
  }
};

const seedReminder = (text: string, dueAt: string | null, recurrence: Recurrence | null = null) =>
  run((db) =>
    createReminder(db, {
      text,
      dueAt,
      recurrence,
      source: 'telegram:1',
      receivedAt: '2026-10-20T08:00:00.000Z',
      now: '2026-10-20T08:00:00.000Z',
    }),
  );

/** The permission the principal's "Sí" grants (R-26 AC2). */
const grant = (time: string, grantedAt = '2026-10-20T08:00:00.000Z') =>
  run((db) =>
    db
      .prepare(
        "INSERT INTO permissions (operation, conditions_json, granted_at) VALUES ('send_morning_digest', ?, ?)",
      )
      .run(JSON.stringify({ time }), grantedAt),
  );

const seedExpense = (status: 'pending' | 'current') =>
  run((db) =>
    db
      .prepare(
        `INSERT INTO expenses (occurred_on, total_cents, mode, status, created_at)
         VALUES ('2026-10-29', 2340, 'inferred', ?, '2026-10-29T10:00:00.000Z')`,
      )
      .run(status),
  );

const digestSends = () => run((db) => db.prepare('SELECT day, sent_at FROM digest_sends').all());
const texts = () => api.sent.map(({ text }) => text);
const logged = () =>
  JSON.stringify([
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
  ]);

/** A reminder due at `at`: its S-42 shows the digest job, which runs just before it, is done. */
const sentinel = (at: Date) => seedReminder('regar las plantas', at.toISOString());

const DIGEST = [
  'Buenos días.',
  'Hoy:',
  '· 9:00 llamar a mamá',
  '· 13:00 tomar la pastilla',
  '· 18:00 sacar la basura',
  'Pendientes:',
  '· comprar pilas',
  '· pagar la luz',
  'Gastos por confirmar: 2',
].join('\n');

const seedDay = () => {
  seedReminder('sacar la basura', '2026-10-30T17:00:00.000Z');
  seedReminder('comprar pilas', null);
  seedReminder('llamar a mamá', '2026-10-30T08:00:00.000Z');
  seedReminder('tomar la pastilla', '2026-10-30T12:00:00.000Z', { freq: 'daily', time: '13:00' });
  // Not today: left out.
  seedReminder('ir al dentista', '2026-10-31T08:00:00.000Z');
  seedReminder('pagar la luz', null);
  seedExpense('pending');
  seedExpense('current');
  seedExpense('pending');
};

describe('sending the morning digest over Telegram (R-26 AC5-AC7)', () => {
  it('AC5: sends S-57 at its time, built by code with no processor call, and never twice a day', async () => {
    grant('07:30');
    seedDay();

    await start(AT_0730);
    expect((await api.waitForSent(1))[0]).toMatchObject({ chatId: PRINCIPAL, text: DIGEST });
    await vi.waitFor(() =>
      expect(digestSends()).toEqual([{ day: '2026-10-30', sent_at: AT_0730.toISOString() }]),
    );
    expect(turns).toEqual([]);
    expect(run((db) => db.prepare('SELECT * FROM ai_usage').all())).toEqual([]);

    const later = new Date('2026-10-30T06:31:05.000Z');
    sentinel(later);
    await start(later);
    await api.waitForSent(2);
    expect(texts()).toEqual([DIGEST, 'Recordatorio: regar las plantas.']);
    expect(logged()).not.toMatch(/mamá|pilas|basura|pastilla|plantas/);
  });

  it('AC5: a part with nothing is left out, and nothing is sent when every part is empty', async () => {
    grant('07:30');
    seedExpense('pending');

    await start(AT_0730);
    expect((await api.waitForSent(1))[0]?.text).toBe('Buenos días.\nGastos por confirmar: 1');

    // The next day nothing is pending: nothing is sent, and the day is handled, so a task added
    // later that morning does not bring a digest.
    run((db) => db.prepare("UPDATE expenses SET status = 'current'").run());
    const nextDay = new Date('2026-10-31T06:30:05.000Z');
    sentinel(nextDay);
    await start(nextDay);
    await api.waitForSent(2);
    seedReminder('comprar pilas', null);
    const later = new Date('2026-10-31T07:00:05.000Z');
    sentinel(later);
    await start(later);
    await api.waitForSent(3);

    expect(texts()).toEqual([
      'Buenos días.\nGastos por confirmar: 1',
      'Recordatorio: regar las plantas.',
      'Recordatorio: regar las plantas.',
    ]);
  });

  it('AC5: sends nothing while the permission is not active, or before its time', async () => {
    seedDay();
    sentinel(AT_0730);
    await start(AT_0730);
    await api.waitForSent(1);

    grant('08:00');
    const before = new Date('2026-10-30T06:59:05.000Z');
    sentinel(before);
    await start(before);
    await api.waitForSent(2);

    expect(texts()).toEqual([
      'Recordatorio: regar las plantas.',
      'Recordatorio: regar las plantas.',
    ]);
    expect(digestSends()).toEqual([]);
  });

  it('AC6: a digest missed while the daemon was down goes out at startup before 12:00', async () => {
    grant('07:30');
    seedDay();

    const late = new Date('2026-10-30T10:59:05.000Z');
    await start(late);

    // Only the reminders still ahead of 11:59 are today's.
    expect((await api.waitForSent(1))[0]?.text).toBe(
      [
        'Buenos días.',
        'Hoy:',
        '· 13:00 tomar la pastilla',
        '· 18:00 sacar la basura',
        'Pendientes:',
        '· comprar pilas',
        '· pagar la luz',
        'Gastos por confirmar: 2',
      ].join('\n'),
    );
  });

  it('AC6: from 12:00 on, a missed digest is skipped for the day', async () => {
    grant('07:30');
    seedReminder('comprar pilas', null);

    const noon = new Date('2026-10-30T11:00:05.000Z');
    sentinel(noon);
    await start(noon);
    await api.waitForSent(1);

    expect(texts()).toEqual(['Recordatorio: regar las plantas.']);
  });

  it('AC5 (assumption): a permission granted after its time today first sends tomorrow', async () => {
    grant('07:30', '2026-10-30T07:00:00.000Z');
    seedReminder('comprar pilas', null);

    const eight = new Date('2026-10-30T07:00:05.000Z');
    sentinel(eight);
    await start(eight);
    await api.waitForSent(1);

    expect(texts()).toEqual(['Recordatorio: regar las plantas.']);
  });

  it('AC7: a failed send logs no text and is retried on the next run', async () => {
    grant('07:30');
    seedReminder('comprar pilas', null);
    api.refuseNextSends(1, 400);

    await start(AT_0730);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(digestSends()).toEqual([]);
    expect(logged()).not.toContain('pilas');

    await start(new Date('2026-10-30T06:31:05.000Z'));
    expect((await api.waitForSent(1))[0]?.text).toBe('Buenos días.\nPendientes:\n· comprar pilas');
  });

  it('R-16 AC3: the digest is a recent turn, sent unasked', async () => {
    grant('07:30');
    seedReminder('comprar pilas', null);

    await start(AT_0730);
    await api.waitForSent(1);
    api.push(updates.text({ chatId: PRINCIPAL }, 'hola'));
    await api.waitForSent(2);

    expect(turns.at(-1)).toMatchObject({
      recent: [{ principal: null, reply: 'Buenos días.\nPendientes:\n· comprar pilas' }],
      message: 'hola',
    });
  });
});
