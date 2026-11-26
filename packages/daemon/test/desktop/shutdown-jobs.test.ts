import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_CHANNEL_PROTOCOL, type Reply } from '@anomander/protocol';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startJobs } from '../../src/app/jobs.ts';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { createAiBudget } from '../../src/budget/ai-budget.ts';
import { loadConfig } from '../../src/config.ts';
import { createReceiptExpenseCycle } from '../../src/expenses/receipt-expense.ts';
import { verbatimReplies } from '../../src/processor/reply-phraser.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// B51, B69: what the daemon does with the jobs and the doors once it stops or crashes. A receipt
// queued by the budget is read by the startup drain, which holds the jobs' chain while its
// reading waits; what the app's connection or the scheduler queue meanwhile waits behind it.
const TOKEN = 'shutdown-jobs-token-0123456789abcdef';
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-10-31T10:00:00.000Z');
const PRINCIPAL = 4242;

let scratch: string;
let api: FakeTelegramApi | undefined;
let anomander: Anomander | undefined;
let sockets: WebSocket[] = [];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A promise settled from outside. */
const pending = <T>() => {
  let settle = (_: T): void => {};
  const promise = new Promise<T>((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, settle };
};

const pause = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/** Queues one receipt, received half an hour before `NOW`, as the budget queues it. */
const queueReceipt = async (dbPath: string, inbox: string) => {
  const db = openDatabase(dbPath);
  applyMigrations(db);
  const at = () => new Date('2026-10-31T09:30:00.000Z');
  await createReceiptExpenseCycle({
    db,
    reader: async () => {
      throw new Error('not read here');
    },
    budget: createAiBudget({ db, limit: 0, timeZone: TZ, now: at }),
    inboxDir: inbox,
    timeZone: TZ,
    now: at,
    processorSource: 'processor:openai/gpt-4o',
    phraser: verbatimReplies,
    logger,
  }).onReceipt({
    images: [{ mimeType: 'image/jpeg', load: async () => new Uint8Array([1]) }],
    caption: null,
    channelRef: 'telegram:7',
    receivedAt: at().toISOString(),
  });
  db.close();
};

const configFor = (env: Record<string, string>) => ({
  ...loadConfig({
    ANOMANDER_LOCAL_TOKEN: TOKEN,
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
    TZ,
    ...env,
  }),
  localPort: 0,
});

const connectApp = async (daemon: Anomander) => {
  const address = await daemon.localChannel;
  if (address === undefined) throw new Error('no local channel');
  const socket = new WebSocket(`ws://${address.host}:${address.port}`, [
    LOCAL_CHANNEL_PROTOCOL,
    TOKEN,
  ]);
  sockets.push(socket);
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener('open', () => resolveOpen());
    socket.addEventListener('error', () => reject(new Error('the app could not connect')));
  });
  return socket;
};

const jobFailures = () =>
  logger.error.mock.calls.filter(([message]) => message === 'scheduled job failed');

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-shutdown-jobs-'));
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets = [];
  await anomander?.stop();
  anomander = undefined;
  await api?.close();
  api = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

describe('the jobs run when the app connects (B69)', () => {
  /** `startJobs` over the scratch store; `readQueued` waits while `hold` is set. */
  const jobsOverQueue = async () => {
    const config = configFor({});
    await queueReceipt(config.dbPath, config.inboxDir);
    const db = openDatabase(config.dbPath);
    const state: { reads: number; hold: Promise<void> | undefined } = { reads: 0, hold: undefined };
    const jobs = startJobs({
      config,
      db,
      now: () => NOW,
      notify: async () => {},
      logger,
      // `null`: the budget still refuses, so the receipt stays queued for the next drain.
      readQueued: async (): Promise<Reply | null> => {
        state.reads += 1;
        if (state.hold !== undefined) await state.hold;
        return null;
      },
      reachable: () => true,
    });
    return { db, jobs, state };
  };

  it('a storm of connections queues one run of each job while one waits, not one per connection', async () => {
    const first = pending<void>();
    const second = pending<void>();
    const { db, jobs, state } = await jobsOverQueue();
    state.hold = first.promise;
    try {
      // The startup drain reads, and holds the chain.
      await vi.waitFor(() => expect(state.reads).toBe(1));
      for (let connection = 0; connection < 5; connection += 1) void jobs.drainQueue();
      state.hold = second.promise;
      first.settle();
      // The five waiting runs were one.
      await vi.waitFor(() => expect(state.reads).toBe(2));
      // A connection once that run started queues another.
      const after = jobs.drainQueue();
      state.hold = undefined;
      second.settle();
      await after;
      await pause(50);

      expect(state.reads).toBe(3);
    } finally {
      state.hold = undefined;
      first.settle();
      second.settle();
      await jobs.scheduler.stop();
      db.close();
    }
  });

  it('a job queued before the stop never runs once the stop began', async () => {
    const first = pending<void>();
    const { db, jobs, state } = await jobsOverQueue();
    state.hold = first.promise;
    try {
      await vi.waitFor(() => expect(state.reads).toBe(1));
      const queued = jobs.drainQueue();
      const stopped = jobs.stop();
      first.settle();
      await stopped;

      await expect(queued).resolves.toBeUndefined();
      expect(state.reads).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('stopping the daemon (B69, B51)', () => {
  const start = async (complete: () => Promise<never>, { queued = true } = {}) => {
    api = await startFakeTelegramApi();
    const config = configFor({
      TELEGRAM_BOT_TOKEN: api.token,
      ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    });
    if (queued) await queueReceipt(config.dbPath, config.inboxDir);
    const daemon = startAnomander(config, {
      complete,
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      now: () => NOW,
      shutdownDeadlineMs: 50,
    });
    anomander = daemon;
    return daemon;
  };

  /** What was logged as an error about a store already closed. */
  const closedStore = () =>
    logger.error.mock.calls.filter(([, fields]) => /not open/.test(String(fields?.error)));

  it('past its deadline, a job a connection started ends before the store closes', async () => {
    const reading = pending<void>();
    const complete = vi.fn(async (): Promise<never> => {
      await reading.promise;
      throw new Error('probe: no processor');
    });
    const daemon = await start(complete, { queued: false });
    await daemon.started;
    // The jobs run once at start; then a receipt waits, for the app's connection to read.
    await pause(300);
    await queueReceipt(join(scratch, 'anomander.db'), join(scratch, 'inbox'));
    await connectApp(daemon);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    const stopped = daemon.stop();
    anomander = undefined;
    // Well past the 50 ms deadline.
    await pause(200);
    reading.settle();
    await stopped;
    await pause(200);

    expect(closedStore()).toEqual([]);
    expect(jobFailures()).toEqual([]);
    // A job is no turn: the deadline's warning does not call it one.
    expect(logger.warn).not.toHaveBeenCalledWith(
      'anomander stopped before every turn ended: 50 ms passed',
    );
  });

  it('past its deadline, the jobs a connection queued never run', async () => {
    const reading = pending<void>();
    const complete = vi.fn(async (): Promise<never> => {
      await reading.promise;
      throw new Error('probe: no processor');
    });
    const daemon = await start(complete);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    // Its digest, reminders and drain wait behind the startup drain.
    await connectApp(daemon);
    await pause(50);

    const stopped = daemon.stop();
    anomander = undefined;
    reading.settle();
    await stopped;
    await pause(200);

    expect(closedStore()).toEqual([]);
    expect(jobFailures()).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('B51: once halted, a text from Telegram reaches no processor and the app cannot connect', async () => {
    const complete = vi.fn(async (): Promise<never> => {
      throw new Error('probe: no processor');
    });
    const daemon = await start(complete);
    await daemon.started;
    await daemon.localChannel;
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    // What the startup drain tells about the receipt it could not read is out.
    await pause(300);
    const sentBefore = api?.sent.map(({ text }) => text) ?? [];

    daemon.halt();
    api?.push(updates.text({ chatId: PRINCIPAL }, '23 € cena'));
    await pause(300);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(api?.sent.map(({ text }) => text)).toEqual(sentBefore);
    await expect(connectApp(daemon)).rejects.toThrow('the app could not connect');
    // A stop after the halt still ends cleanly.
    await daemon.stop();
    anomander = undefined;
    expect(jobFailures()).toEqual([]);
  });
});
