import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDailyBackup } from '../../src/backup/daily-backup.ts';
import { backupDatabase, hasDailyBackupOn } from '../../src/store/backup.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// B54 (R4-partial-daily-copy-counts-as-done): a copy is written under `<name>.partial` and takes
// its name only once complete, so a daemon killed while it copies leaves no file that counts as
// the day's copy; the `.partial` it leaves is deleted at the next copy.
const NOW = new Date('2026-11-24T03:00:00.000Z');
const DAILY = 'anomander.db.backup-daily-20261124T030000Z';

let scratch: string;
let db: Database.Database;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  scratch = mkdtempSync(join(tmpdir(), 'anomander-partial-backup-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const backups = () =>
  readdirSync(scratch)
    .filter((name) => name.startsWith('anomander.db.backup-'))
    .sort();

/** Runs `look` while `VACUUM INTO` writes, as a daemon killed at that moment would leave it. */
const whileCopying = (look: () => void) => {
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith('VACUUM INTO')) return statement;
    return {
      run: (target: string) => {
        const result = statement.run(target);
        look();
        return result;
      },
    };
  }) as typeof db.prepare);
};

describe('a copy being written (B54)', () => {
  it('has no name of a daily copy and does not count as the day copy until it is complete', async () => {
    const seen: { names: string[]; counted: boolean }[] = [];
    whileCopying(() => seen.push({ names: backups(), counted: hasDailyBackupOn(db, NOW) }));

    await createDailyBackup({ db, now: () => NOW, logger }).run();

    expect(seen).toEqual([{ names: [`${DAILY}.partial`], counted: false }]);
    expect(backups()).toEqual([DAILY]);
    expect(statSync(join(scratch, DAILY)).mode & 0o777).toBe(0o600);
    const copy = new Database(join(scratch, DAILY), { readonly: true });
    expect(copy.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    copy.close();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a copy taken before a migration is written the same way', () => {
    const seen: string[][] = [];
    whileCopying(() => seen.push(backups()));

    const path = backupDatabase(db, 3, NOW);

    expect(seen).toEqual([['anomander.db.backup-v3-20261124T030000Z.partial']]);
    expect(backups()).toEqual(['anomander.db.backup-v3-20261124T030000Z']);
    expect(path).toBe(join(scratch, 'anomander.db.backup-v3-20261124T030000Z'));
  });

  it('a .partial left by a killed daemon never counts, and the next copy deletes it', async () => {
    const left = [
      `${DAILY}.partial`,
      'anomander.db.backup-daily-20261123T030000Z-1.partial',
      'anomander.db.backup-v2-20261120T000000Z.partial',
    ];
    // Not a leftover of this database's copies: never touched.
    const others = ['other.db.backup-daily-20261123T030000Z.partial', 'anomander.db.partial'];
    for (const name of [...left, ...others]) writeFileSync(join(scratch, name), 'half');

    expect(hasDailyBackupOn(db, NOW)).toBe(false);
    await createDailyBackup({ db, now: () => NOW, logger }).run();

    expect(backups()).toEqual([DAILY, 'anomander.db.backup-v2-20261120T000000Z.partial']);
    expect(readdirSync(scratch)).toEqual(expect.arrayContaining(others));
    // The copies taken before migrations delete their own leftovers.
    backupDatabase(db, 2, NOW);
    expect(backups()).toEqual([DAILY, 'anomander.db.backup-v2-20261124T030000Z']);
  });
});
