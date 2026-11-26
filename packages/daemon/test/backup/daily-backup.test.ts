import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeTelegramApi } from '@anomander/telegram/fake-telegram-api';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAnomander } from '../../src/app.ts';
import { createDailyBackup } from '../../src/backup/daily-backup.ts';
import { loadConfig } from '../../src/config.ts';
import { recordMessages } from '../../src/store/conversation.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// B5: a `VACUUM INTO` copy of the database once a day, beside it, mode 600, the 7 newest kept,
// apart from the 3 copies taken before migrations. Taken right after the retention job, so a copy
// never holds what retention already erased.
const DAILY_NAME = /^anomander\.db\.backup-daily-\d{8}T\d{6}Z(-\d+)?$/;
const NOW = new Date('2026-11-24T03:00:00.000Z');

let scratch: string;
let db: Database.Database;

const dailyCopies = (): string[] =>
  readdirSync(scratch)
    .filter((name) => DAILY_NAME.test(name))
    .sort();

const quietLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-daily-backup-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
});

afterEach(() => {
  chmodSync(scratch, 0o700);
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the daily backup', () => {
  it('writes one copy a day beside the database, mode 600, holding its data', async () => {
    db.prepare('CREATE TABLE marker (value TEXT)').run();
    db.prepare("INSERT INTO marker VALUES ('kept')").run();
    let now = NOW;
    const backup = createDailyBackup({ db, now: () => now, logger: quietLogger() });

    await backup.run();
    // A second run the same day, such as a restart, makes no second copy.
    now = new Date('2026-11-24T21:00:00.000Z');
    await backup.run();

    const copies = dailyCopies();
    expect(copies).toEqual(['anomander.db.backup-daily-20261124T030000Z']);
    const path = join(scratch, copies[0] ?? '');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const copy = new Database(path, { readonly: true });
    expect(copy.prepare('SELECT value FROM marker').pluck().get()).toBe('kept');
    copy.close();

    now = new Date('2026-11-25T03:00:00.000Z');
    await backup.run();
    expect(dailyCopies()).toHaveLength(2);
  });

  it('keeps the 7 newest daily copies and never touches the copies taken before migrations', async () => {
    const older = [
      'anomander.db.backup-daily-20261116T030000Z',
      'anomander.db.backup-daily-20261117T030000Z',
      'anomander.db.backup-daily-20261118T030000Z',
      'anomander.db.backup-daily-20261119T030000Z',
      'anomander.db.backup-daily-20261120T030000Z',
      'anomander.db.backup-daily-20261121T030000Z',
      'anomander.db.backup-daily-20261122T030000Z',
      'anomander.db.backup-daily-20261123T030000Z',
    ];
    const others = [
      'anomander.db.backup-v1-20200101T000000Z',
      'anomander.db.backup-v2-20200102T000000Z',
      'anomander.db.backup-v3-20200103T000000Z',
      'anomander.db.backup-daily-notes',
      'other.db.backup-daily-20200101T000000Z',
    ];
    for (const name of [...older, ...others]) writeFileSync(join(scratch, name), '');

    await createDailyBackup({ db, now: () => NOW, logger: quietLogger() }).run();

    expect(dailyCopies()).toEqual([
      ...older.slice(2),
      'anomander.db.backup-daily-20261124T030000Z',
    ]);
    const left = readdirSync(scratch);
    for (const name of others) expect(left).toContain(name);
  });

  it('B52: a copy stamped in the future, by a clock once ahead, never stands for a real day', async () => {
    // The clock was once 5 days ahead: the copy of real 24 November says 29 November, 12:00.
    let now = new Date('2026-11-29T12:00:00.000Z');
    const backup = createDailyBackup({ db, now: () => now, logger: quietLogger() });
    await backup.run();

    // Back on time, one run a day: the real 29 November gets its own copy.
    for (const day of [25, 26, 27, 28, 29]) {
      now = new Date(`2026-11-${day}T03:00:00.000Z`);
      await backup.run();
    }

    expect(dailyCopies()).toContain('anomander.db.backup-daily-20261129T030000Z');
  });

  it('B52: prunes copies stamped in the future first, so they never pile up', async () => {
    // A week with the clock a year ahead left 7 copies stamped in 2027.
    const ahead = [17, 18, 19, 20, 21, 22, 23].map(
      (day) => `anomander.db.backup-daily-202711${day}T030000Z`,
    );
    for (const name of ahead) writeFileSync(join(scratch, name), '');

    let now = NOW;
    const backup = createDailyBackup({ db, now: () => now, logger: quietLogger() });
    const real: string[] = [];
    for (const day of [24, 25, 26, 27, 28, 29, 30]) {
      now = new Date(`2026-11-${day}T03:00:00.000Z`);
      await backup.run();
      real.push(`anomander.db.backup-daily-202611${day}T030000Z`);
      // Every real copy taken so far is kept; the future ones go first, oldest stamp first.
      expect(dailyCopies().filter((name) => !ahead.includes(name))).toEqual(real);
    }

    expect(dailyCopies()).toEqual(real);
  });

  it('logs a failed copy without its path, leaves nothing behind and copies at the next run', async () => {
    const logger = quietLogger();
    let now = NOW;
    const backup = createDailyBackup({ db, now: () => now, logger });
    chmodSync(scratch, 0o500);

    await expect(backup.run()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(scratch);
    expect(dailyCopies()).toEqual([]);

    chmodSync(scratch, 0o700);
    now = new Date('2026-11-25T03:00:00.000Z');
    await backup.run();
    expect(dailyCopies()).toEqual(['anomander.db.backup-daily-20261125T030000Z']);
  });

  it('is taken at startup by the scheduler, after retention erased the old conversation', async () => {
    recordMessages(db, [
      {
        from: 'principal',
        door: 'telegram',
        text: 'from long ago',
        buttons: [],
        channelRef: null,
        at: '2026-01-01T10:00:00.000Z',
      },
      {
        from: 'principal',
        door: 'telegram',
        text: 'from yesterday',
        buttons: [],
        channelRef: null,
        at: '2026-11-23T10:00:00.000Z',
      },
    ]);
    const api = await startFakeTelegramApi();
    const anomander = startAnomander(
      loadConfig({
        TELEGRAM_BOT_TOKEN: api.token,
        ANOMANDER_PRINCIPAL_CHAT_ID: '4242',
        ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
        ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
        ANOMANDER_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
      }),
      {
        complete: vi.fn(async () => {
          throw new Error('the processor must not be called');
        }),
        model: 'openai/gpt-4o-mini',
        telegramApiRoot: api.apiRoot,
        logger: quietLogger(),
        now: () => NOW,
      },
    );
    try {
      await anomander.started;
      await vi.waitFor(() => expect(dailyCopies()).toHaveLength(1));
    } finally {
      await anomander.stop();
      await api.close();
    }

    const copy = new Database(join(scratch, dailyCopies()[0] ?? ''), { readonly: true });
    expect(copy.prepare('SELECT text FROM conversation ORDER BY id').pluck().all()).toEqual([
      'from yesterday',
    ]);
    copy.close();
  });
});
