import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDatabase, backupDatabaseDaily } from '../../src/store/backup.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// B54: the independent verifier's probes of the copies written as `.partial`, kept as
// regression tests.
const NOW = new Date('2026-11-28T10:00:00.000Z');
let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anomander-partial-probes-'));
  db = openDatabase(join(dir, 'anomander.db'));
  applyMigrations(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const names = () =>
  readdirSync(dir)
    .filter((n) => n.includes('.backup-'))
    .sort();

describe('verifier probes: .partial backups (B54)', () => {
  it('keeps .partial files of another database and of the other kind', () => {
    const keep = [
      'other.db.backup-daily-20261128T090000Z.partial',
      'anomander.db.backup-v3-20261128T090000Z.partial',
      'xanomander.db.backup-daily-20261128T090000Z.partial',
      'anomander.db.backup-daily-junk.partial',
    ];
    for (const n of keep) writeFileSync(join(dir, n), 'x');
    writeFileSync(join(dir, 'anomander.db.backup-daily-20261127T090000Z-2.partial'), 'x');
    backupDatabaseDaily(db, NOW);
    for (const n of keep) expect(existsSync(join(dir, n))).toBe(true);
    expect(existsSync(join(dir, 'anomander.db.backup-daily-20261127T090000Z-2.partial'))).toBe(
      false,
    );
    // the pre-migration copy removes its own kind only
    writeFileSync(join(dir, 'anomander.db.backup-daily-20261128T080000Z.partial'), 'x');
    backupDatabase(db, 3, NOW);
    expect(existsSync(join(dir, 'anomander.db.backup-daily-20261128T080000Z.partial'))).toBe(true);
    expect(existsSync(join(dir, 'anomander.db.backup-v3-20261128T090000Z.partial'))).toBe(false);
  });

  it('pruning keeps 7 daily copies, ignores .partial in the count, same second gets -1', () => {
    for (let d = 10; d < 20; d += 1)
      writeFileSync(join(dir, `anomander.db.backup-daily-202611${d}T000000Z`), 'x');
    writeFileSync(join(dir, 'other.db.backup-daily-20261101T000000Z.partial'), 'x');
    const first = backupDatabaseDaily(db, NOW);
    const second = backupDatabaseDaily(db, NOW);
    expect(second).toBe(`${first}-1`);
    const daily = names().filter((n) => n.startsWith('anomander.db.backup-daily-'));
    expect(daily).toHaveLength(7);
    expect(daily.some((n) => n.endsWith('.partial'))).toBe(false);
    expect(statSync(second).mode & 0o777).toBe(0o600);
  });
});
