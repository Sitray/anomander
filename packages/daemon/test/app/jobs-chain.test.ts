import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Reply } from '@anomander/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startJobs } from '../../src/app/jobs.ts';
import { loadConfig } from '../../src/config.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// B69: the jobs' chain, merged runs and halt (the verifier's probes for S3).
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let scratch: string;
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const setup = (sendCount: { n: number }) => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-jobs-chain-'));
  const config = loadConfig({
    ANOMANDER_LOCAL_TOKEN: 'probe-local-token-0123456789abcdef',
    ANOMANDER_DB_PATH: join(scratch, 'a.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    TZ: 'Europe/Madrid',
  });
  const db = openDatabase(config.dbPath);
  applyMigrations(db);
  let reach = 0;
  const jobs = startJobs({
    config,
    db,
    now: () => new Date('2026-10-31T10:00:00.000Z'),
    notify: async () => {},
    logger,
    readQueued: async (): Promise<Reply | null> => null,
    // Every merged job asks `reachable` once as it starts: count the runs through it.
    reachable: () => {
      reach += 1;
      sendCount.n += 1;
      return false;
    },
  });
  return { db, jobs, reached: () => reach };
};

describe('verifier S3', () => {
  it('a merged job asked while its run is running queues one more run, which still runs', async () => {
    const count = { n: 0 };
    const { db, jobs } = setup(count);
    await jobs.scheduler.started;
    const before = count.n;
    // Ask three times at once: one run; ask again after it started: one more run.
    const a = jobs.sendDueReminders();
    const b = jobs.sendDueReminders();
    expect(a).toBe(b);
    await a;
    const c = jobs.sendDueReminders();
    expect(c).not.toBe(a);
    await c;
    expect(count.n - before).toBe(2);
    await jobs.stop();
    db.close();
  });

  it('a merged run that failed does not keep answering later requests', async () => {
    const count = { n: 0 };
    const { db, jobs } = setup(count);
    await jobs.scheduler.started;
    const first = jobs.drainQueue();
    await first;
    const second = jobs.drainQueue();
    expect(second).not.toBe(first);
    await second;
    await jobs.stop();
    db.close();
  });

  it('after halt, every request resolves undefined at once and stop still ends; stop twice is fine', async () => {
    const count = { n: 0 };
    const { db, jobs } = setup(count);
    await jobs.scheduler.started;
    const before = count.n;
    jobs.halt();
    await expect(jobs.sendMorningDigest()).resolves.toBeUndefined();
    await expect(jobs.drainQueue()).resolves.toBeUndefined();
    await Promise.all([jobs.stop(), jobs.stop()]);
    expect(count.n).toBe(before);
    db.close();
  });
});
