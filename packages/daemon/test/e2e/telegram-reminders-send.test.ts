import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeTelegramApi, startFakeTelegramApi } from '@anomander/telegram/fake-telegram-api';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import type { Recurrence } from '../../src/reminders/when.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { createReminder } from '../../src/store/reminders.ts';

// End to end (PRD §15): due reminders reach the principal unasked (R-25 AC7, R-16 AC3) over the
// fake Telegram API, from the scheduler's startup run. A restart runs the same job as the
// every-minute tick, so it stands in for the next minute.
const PRINCIPAL = 4242;
// Friday 30 October 2026, 11:00 in Madrid (UTC+1).
const NOW = new Date('2026-10-30T10:00:05.000Z');

let scratch: string;
let dbPath: string;
let api: FakeTelegramApi;
let anomander: Anomander | undefined;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-reminders-send-'));
  dbPath = join(scratch, 'anomander.db');
  const db = openDatabase(dbPath);
  applyMigrations(db);
  db.close();
  api = await startFakeTelegramApi();
  logger = { info: vi.fn<Log>(), warn: vi.fn<Log>(), error: vi.fn<Log>() };
});

afterEach(async () => {
  await anomander?.stop();
  anomander = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Starts the daemon on the seeded store with the clock at `at`; no processor call is expected. */
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
    {
      complete: async () => {
        throw new Error('the processor must not be called');
      },
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      now: () => at,
    },
  );
  await anomander.started;
};

const seed = (text: string, dueAt: string | null, recurrence: Recurrence | null = null) => {
  const db = new Database(dbPath);
  try {
    createReminder(db, {
      text,
      dueAt,
      recurrence,
      source: 'telegram:1',
      receivedAt: '2026-10-20T08:00:00.000Z',
      now: '2026-10-20T08:00:00.000Z',
    });
  } finally {
    db.close();
  }
};

const reminders = () => {
  const db = new Database(dbPath);
  try {
    return db
      .prepare('SELECT text, due_at, status, last_sent_at, closed_at FROM reminders ORDER BY id')
      .all();
  } finally {
    db.close();
  }
};

const texts = () => api.sent.map(({ text }) => text);

describe('sending due reminders over Telegram (R-25 AC7)', () => {
  it('sends a due one-time reminder as S-42, marks it sent, and does not send it again', async () => {
    seed('llamar a mamá', '2026-10-30T10:00:00.000Z');
    seed('sacar la basura', '2026-10-30T10:01:00.000Z');

    await start(NOW);
    expect((await api.waitForSent(1))[0]).toMatchObject({
      chatId: PRINCIPAL,
      text: 'Recordatorio: llamar a mamá.',
    });
    // It is marked once the send has returned.
    await vi.waitFor(() =>
      expect(reminders()).toEqual([
        {
          text: 'llamar a mamá',
          due_at: '2026-10-30T10:00:00.000Z',
          status: 'sent',
          last_sent_at: NOW.toISOString(),
          closed_at: NOW.toISOString(),
        },
        expect.objectContaining({ text: 'sacar la basura', status: 'pending' }),
      ]),
    );

    // The next minute: the sent one is no longer pending; only the newly due one goes out.
    await start(new Date('2026-10-30T10:01:05.000Z'));
    await api.waitForSent(2);
    expect(texts()).toEqual(['Recordatorio: llamar a mamá.', 'Recordatorio: sacar la basura.']);
  });

  it('sends a reminder missed while the daemon was down as S-43 with its time', async () => {
    seed('llamar a mamá', '2026-10-29T08:00:00.000Z');

    await start(NOW);

    expect((await api.waitForSent(1))[0]?.text).toBe(
      'Recordatorio (era para ayer a las 9:00): llamar a mamá.',
    );
    await vi.waitFor(() =>
      expect(reminders()).toEqual([expect.objectContaining({ status: 'sent' })]),
    );
  });

  it('sends only the latest missed occurrence of a repeating reminder and moves to the next one', async () => {
    // Daily at 9:00, last due on Tuesday: Tuesday to Friday were missed.
    seed('tomar la pastilla', '2026-10-27T08:00:00.000Z', { freq: 'daily', time: '09:00' });
    // Due after the repeating one: had it sent more than once, this would not be second.
    seed('llamar a mamá', '2026-10-30T10:00:00.000Z');

    await start(NOW);
    await api.waitForSent(2);

    expect(texts()).toEqual([
      'Recordatorio (era para hoy a las 9:00): tomar la pastilla.',
      'Recordatorio: llamar a mamá.',
    ]);
    expect(reminders()[0]).toEqual({
      text: 'tomar la pastilla',
      due_at: '2026-10-31T08:00:00.000Z',
      status: 'pending',
      last_sent_at: NOW.toISOString(),
      closed_at: null,
    });
  });

  it('never sends a task', async () => {
    seed('comprar pilas', null);
    seed('llamar a mamá', '2026-10-30T10:00:00.000Z');

    await start(NOW);
    await api.waitForSent(1);

    expect(texts()).toEqual(['Recordatorio: llamar a mamá.']);
    expect(reminders()[0]).toMatchObject({ text: 'comprar pilas', status: 'pending' });
  });

  it('keeps a reminder whose send failed due, logging no text (AC12), and sends it on the next run', async () => {
    seed('llamar a mamá', '2026-10-30T10:00:00.000Z');
    api.refuseNextSends(1, 400);

    await start(NOW);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(reminders()).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('mamá');

    await start(new Date('2026-10-30T10:01:05.000Z'));
    expect((await api.waitForSent(1))[0]?.text).toBe('Recordatorio: llamar a mamá.');
  });
});
