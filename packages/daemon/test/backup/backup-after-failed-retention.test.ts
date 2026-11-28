import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Reply } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startJobs } from '../../src/app/jobs.ts';
import { loadConfig } from '../../src/config.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// B54 (R3-backup-after-failed-retention-untested): the daily copy is taken right after the
// retention job, and a retention run that fails does not cost the day its copy.
const DAILY_NAME = /^anomander\.db\.backup-daily-\d{8}T\d{6}Z(-\d+)?$/;

let scratch: string;
let db: Database.Database;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  scratch = mkdtempSync(join(tmpdir(), 'anomander-backup-after-retention-'));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the daily copy after a failed retention run', () => {
  it('is still taken, and the failure is logged as the retention job', async () => {
    const config = loadConfig({
      ANOMANDER_LOCAL_TOKEN: 'probe-local-token-0123456789abcdef',
      ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
      ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
      ANOMANDER_MODEL: 'openai/gpt-4o-mini',
      TZ: 'Europe/Madrid',
    });
    db = openDatabase(config.dbPath);
    applyMigrations(db);
    // Retention erases old messages of the stored conversation last: without it, the run fails.
    db.exec('DROP TABLE conversation');

    const jobs = startJobs({
      config,
      db,
      now: () => new Date('2026-11-24T03:00:00.000Z'),
      notify: async () => {},
      logger,
      readQueued: async (): Promise<Reply | null> => null,
      reachable: () => false,
    });
    try {
      await jobs.scheduler.started;
    } finally {
      await jobs.stop();
    }

    expect(logger.error).toHaveBeenCalledWith('scheduled job failed', {
      job: 'retain',
      error: expect.any(Error),
    });
    expect(readdirSync(scratch).filter((name) => DAILY_NAME.test(name))).toEqual([
      'anomander.db.backup-daily-20261124T030000Z',
    ]);
  });
});
