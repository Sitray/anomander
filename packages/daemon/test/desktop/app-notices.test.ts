import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChatEvent, LOCAL_CHANNEL_PROTOCOL } from '@anomander/protocol';
import { type FakeTelegramApi, startFakeTelegramApi } from '@anomander/telegram/fake-telegram-api';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { createReminder } from '../../src/store/reminders.ts';

// DK-22 (docs/desktop-prd.md): what ANOMANDER sends unasked also reaches the desktop app while it
// is connected, as a `notice` pushed on the local channel, and is kept once in the stored
// conversation (DK-16). A real WebSocket client against a started daemon, with the fake Telegram
// API and a SQLite file, as `local-channel.test.ts`. The jobs that send unasked run when the app
// connects, so a connection stands in for the next minute.
const PRINCIPAL = 4242;
const TOKEN = 'app-notices-test-token-0123456789abcdef';
// Friday 30 October 2026, 11:00 in Madrid (UTC+1).
const BEFORE = new Date('2026-10-30T09:59:00.000Z');
const DUE = new Date('2026-10-30T10:00:05.000Z');
const REMINDER = 'Recordatorio: llamar a mamá.';

let scratch: string;
let dbPath: string;
let api: FakeTelegramApi;
let anomander: Anomander | undefined;
let sockets: WebSocket[];
let clock: Date;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-notices-'));
  dbPath = join(scratch, 'anomander.db');
  const db = openDatabase(dbPath);
  applyMigrations(db);
  createReminder(db, {
    text: 'llamar a mamá',
    dueAt: '2026-10-30T10:00:00.000Z',
    recurrence: null,
    source: 'telegram:1',
    receivedAt: '2026-10-20T08:00:00.000Z',
    now: '2026-10-20T08:00:00.000Z',
  });
  db.close();
  api = await startFakeTelegramApi();
  sockets = [];
  clock = BEFORE;
  logger = { info: vi.fn<Log>(), warn: vi.fn<Log>(), error: vi.fn<Log>() };
});

afterEach(async () => {
  for (const socket of sockets) socket.close();
  await anomander?.stop();
  anomander = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

const start = async (telegram: boolean) => {
  anomander = startAnomander(
    {
      ...loadConfig({
        ...(telegram
          ? { TELEGRAM_BOT_TOKEN: api.token, ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL) }
          : {}),
        ANOMANDER_LOCAL_TOKEN: TOKEN,
        ANOMANDER_DB_PATH: dbPath,
        ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
        ANOMANDER_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
        TZ: 'Europe/Madrid',
      }),
      localPort: 0,
    },
    {
      complete: async () => {
        throw new Error('the processor must not be called');
      },
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      now: () => clock,
    },
  );
  await anomander.started;
  return anomander;
};

/** A connected app: every event it got, in order. */
const connectApp = async (daemon: Anomander) => {
  const address = await daemon.localChannel;
  if (address === undefined) throw new Error('the local channel did not start');
  const socket = new WebSocket(`ws://${address.host}:${address.port}`, [
    LOCAL_CHANNEL_PROTOCOL,
    TOKEN,
  ]);
  sockets.push(socket);
  const events: ChatEvent[] = [];
  socket.addEventListener('message', (message) => events.push(JSON.parse(String(message.data))));
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener('open', () => resolveOpen());
    socket.addEventListener('close', () => reject(new Error('closed before it opened')));
  });
  return {
    events,
    ask: (request: Record<string, unknown>) => {
      socket.send(JSON.stringify(request));
    },
  };
};

const query = <T>(sql: string): T[] => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

const reminderStatus = () => query<{ status: string }>('SELECT status FROM reminders');
const stored = () =>
  query<{ sender: string; door: string; text: string; channel_ref: string | null }>(
    'SELECT sender, door, text, channel_ref FROM conversation ORDER BY id',
  );

/** Everything the logger was given, as one text, to show no content reached it. */
const logged = () =>
  JSON.stringify([
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
  ]);

describe('what ANOMANDER sends unasked reaches the app (DK-22)', () => {
  it('S-160 AC1: with Telegram, a due reminder goes to Telegram as before and to the connected app as a notice, kept once', async () => {
    const daemon = await start(true);
    const app = await connectApp(daemon);
    clock = DUE;
    // A second window of the app connects: the jobs that send unasked run now.
    const other = await connectApp(daemon);

    const [sent] = await api.waitForSent(1);
    expect(sent).toMatchObject({ chatId: PRINCIPAL, text: REMINDER });
    await vi.waitFor(() => expect(app.events).toHaveLength(1));
    await vi.waitFor(() => expect(other.events).toHaveLength(1));
    expect(app.events[0]).toEqual({
      type: 'notice',
      inReplyTo: null,
      channelRef: expect.stringMatching(/^desktop:/),
      text: REMINDER,
      buttons: [],
      sentAt: DUE.toISOString(),
    });
    await vi.waitFor(() => expect(reminderStatus()).toEqual([{ status: 'sent' }]));
    // One message of the conversation, as Telegram delivered it (DK-16 AC1).
    expect(stored()).toEqual([
      {
        sender: 'anomander',
        door: 'telegram',
        text: REMINDER,
        channel_ref: `telegram:${sent?.messageId}`,
      },
    ]);
    expect(api.sent).toHaveLength(1);
    expect(logged()).not.toContain('mamá');
  });

  it('S-161 AC2: without Telegram, a reminder due while no app is connected waits, and reaches the app when it connects', async () => {
    clock = DUE;
    const daemon = await start(false);
    // The startup run had no door: it stays due, and nothing failed loudly.
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    expect(reminderStatus()).toEqual([{ status: 'pending' }]);

    const app = await connectApp(daemon);

    await vi.waitFor(() => expect(app.events).toHaveLength(1));
    expect(app.events[0]).toMatchObject({ type: 'notice', text: REMINDER, buttons: [] });
    await vi.waitFor(() => expect(reminderStatus()).toEqual([{ status: 'sent' }]));
    const notice = app.events[0] as { channelRef: string };
    expect(stored()).toEqual([
      { sender: 'anomander', door: 'app', text: REMINDER, channel_ref: notice.channelRef },
    ]);
    // DK-16 AC3: the app that loads the conversation later shows it too.
    app.ask({ type: 'history', id: 'h1' });
    await vi.waitFor(() => expect(app.events).toHaveLength(2));
    expect(app.events[1]).toMatchObject({
      type: 'history',
      messages: [{ from: 'anomander', door: 'app', text: REMINDER }],
    });
    expect(api.sent).toEqual([]);
    expect(logged()).not.toContain('mamá');
  });

  it('S-162: with Telegram and no app connected, Telegram gets it exactly as before', async () => {
    clock = DUE;
    await start(true);

    const [sent] = await api.waitForSent(1);
    expect(sent).toMatchObject({ chatId: PRINCIPAL, text: REMINDER });
    await vi.waitFor(() => expect(reminderStatus()).toEqual([{ status: 'sent' }]));
    expect(stored()).toEqual([
      {
        sender: 'anomander',
        door: 'telegram',
        text: REMINDER,
        channel_ref: `telegram:${sent?.messageId}`,
      },
    ]);
  });
});
