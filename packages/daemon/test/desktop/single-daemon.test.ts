import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBotInUse } from '@anomander/telegram';
import { type FakeTelegramApi, startFakeTelegramApi } from '@anomander/telegram/fake-telegram-api';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Anomander, startAnomander, startSetupGuide } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { acquireDaemonLock, DaemonAlreadyRunningError } from '../../src/store/daemon-lock.ts';

// DK-2 (docs/desktop-prd.md): the desktop app and Docker run the same daemon, never both at once.
const PRINCIPAL = 4242;

let scratch: string;
let api: FakeTelegramApi;
let running: Anomander[];

const dbPath = () => join(scratch, 'data', 'anomander.db');
const config = () =>
  loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: dbPath(),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
  });
const deps = () => ({
  complete: async () => {
    throw new Error('no processor call is expected');
  },
  model: 'openai/gpt-4o-mini',
  telegramApiRoot: api.apiRoot,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});
const start = async (): Promise<Anomander> => {
  const anomander = startAnomander(config(), deps());
  running.push(anomander);
  await anomander.started;
  return anomander;
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-single-'));
  api = await startFakeTelegramApi();
  running = [];
});

afterEach(async () => {
  for (const anomander of running) await anomander.stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the daemon lock', () => {
  it('DK-2 AC1: refuses a second holder and names the database', () => {
    const lock = acquireDaemonLock(dbPath());
    try {
      expect(() => acquireDaemonLock(dbPath())).toThrow(DaemonAlreadyRunningError);
      expect(() => acquireDaemonLock(dbPath())).toThrow(
        `another ANOMANDER daemon is already running on ${dbPath()}`,
      );
    } finally {
      lock.release();
    }
  });

  it('is free again once released, and belongs to its owner only (§16)', () => {
    acquireDaemonLock(dbPath()).release();
    const lock = acquireDaemonLock(dbPath());
    try {
      expect(statSync(`${dbPath()}.lock`).mode & 0o777).toBe(0o600);
      expect(statSync(join(scratch, 'data')).mode & 0o777).toBe(0o700);
    } finally {
      lock.release();
    }
  });
});

describe('a single daemon', () => {
  it('DK-2 AC1: a second daemon on the same database refuses to start; the ledger is unchanged', async () => {
    await start();
    const ledger = () => {
      const db = new Database(dbPath(), { readonly: true });
      try {
        return db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
      } finally {
        db.close();
      }
    };
    const before = ledger();

    expect(() => startAnomander(config(), deps())).toThrow(DaemonAlreadyRunningError);
    expect(() => startSetupGuide(config(), { ...deps(), gaps: [{ kind: 'model_unset' }] })).toThrow(
      DaemonAlreadyRunningError,
    );
    expect(ledger()).toEqual(before);
  });

  it('DK-2 AC1: a stopped daemon frees the database for the next one', async () => {
    const first = await start();
    await first.stop();
    running = [];
    await start();
  });

  it('DK-2 AC2: a 409 from Telegram ends polling with an error that says the bot is in use', async () => {
    const anomander = await start();
    api.conflictPolling();

    const failure = await anomander.polling.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isBotInUse(failure)).toBe(true);
    expect(isBotInUse(new Error('network down'))).toBe(false);
  });

  it('polling ends without an error when the daemon is stopped', async () => {
    const anomander = await start();
    await anomander.stop();
    running = [];
    await expect(anomander.polling).resolves.toBeUndefined();
  });
});
