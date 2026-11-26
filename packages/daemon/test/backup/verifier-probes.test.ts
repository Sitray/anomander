import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDailyBackup } from '../../src/backup/daily-backup.ts';
import {
  backupDatabase,
  backupDatabaseDaily,
  hasDailyBackupOn,
  stamp,
} from '../../src/store/backup.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { exportLedger, InMemoryStoreError } from '../../src/store/export.ts';

// B52, the verifier's probes: backups stamped in the future by a clock that was once ahead, and
// the export of an in-memory store. A copy stamped after `now` is deleted as soon as a new copy is
// written, so it can never stand for a day later on.

const NOW = new Date('2026-11-24T03:00:00.000Z');
const daily = (s: string, n?: number) => `anomander.db.backup-daily-${s}${n ? `-${n}` : ''}`;
const mig = (v: number, s: string) => `anomander.db.backup-v${v}-${s}`;
const day = (offset: number, time = '030000') => {
  const d = new Date(NOW.getTime() + offset * 86_400_000);
  return `${stamp(d).slice(0, 8)}T${time}Z`;
};

let scratch: string;
let db: Database.Database;
const files = () => readdirSync(scratch).sort();
const put = (...names: string[]) => {
  for (const name of names) writeFileSync(join(scratch, name), 'x');
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'verifier-b52-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
});
afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('B52 prune probes', () => {
  it('all copies in the future: keeps the one just written and 6 others, deletes the oldest-stamped', () => {
    // With no copy at or before `now`, the clock may be the one that is wrong: only the usual
    // number of copies goes.
    const future = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => daily(day(d)));
    put(...future);
    const written = backupDatabaseDaily(db, NOW);
    const left = files().filter((n) => n.includes('backup-daily'));
    expect(left).toEqual([...future.slice(2), written.split('/').pop()].sort());
  });

  it('clock behind: 7 real daily copies all stamped after now keep 6 of them beside the new one', () => {
    // The host booted to an old date: a week of real copies looks ahead of `now`.
    const real = [1, 2, 3, 4, 5, 6, 7].map((d) => daily(day(d)));
    put(...real);
    const written = backupDatabaseDaily(db, NOW);
    const left = files().filter((n) => n.includes('backup-daily'));
    expect(left).toEqual([...real.slice(1), written.split('/').pop()].sort());
  });

  it('clock behind: the 3 pre-migration copies all stamped after now keep 2 beside the new one', () => {
    const real = [mig(1, day(1)), mig(2, day(2)), mig(3, day(3))];
    put(...real);
    const written = backupDatabase(db, 4, NOW);
    expect(files().filter((n) => /backup-v\d/.test(n))).toEqual(
      [...real.slice(1), written.split('/').pop()].sort(),
    );
  });

  it('never deletes a real copy while a future one remains', () => {
    const real = [-6, -5, -4, -3, -2, -1].map((d) => daily(day(d)));
    const future = [1, 30, 400].map((d) => daily(day(d)));
    put(...real, ...future);
    backupDatabaseDaily(db, NOW);
    const left = files();
    for (const r of real) expect(left).toContain(r);
    for (const f of future) expect(left).not.toContain(f);
  });

  it('same-second and same-day copies with suffixes are ordered and kept as before', () => {
    put(daily(day(0, '010000')), daily(day(0, '010000'), 1), daily(day(0, '030000')));
    const written = backupDatabaseDaily(db, NOW, 3);
    // `now` equals 030000: the existing same-second copy is not ahead.
    expect(written.endsWith(`${day(0)}-1`)).toBe(true);
    expect(files().filter((n) => n.includes('backup-daily'))).toEqual([
      daily(day(0, '010000'), 1),
      daily(day(0, '030000')),
      daily(day(0, '030000'), 1),
    ]);
  });

  it('never deletes files that only look like backups', () => {
    const strangers = [
      'anomander.db.backup-daily-foo',
      `anomander.db.backup-daily-${day(5)}.bak`,
      `other.db.backup-daily-${day(5)}`,
      `xanomander.db.backup-daily-${day(5)}`,
      `anomander.db.backup-weekly-${day(5)}`,
    ];
    put(...strangers, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => daily(day(d))));
    backupDatabaseDaily(db, NOW);
    for (const s of strangers) expect(files()).toContain(s);
    expect(files()).toContain('anomander.db');
  });

  it('pre-migration keep-3 holds, future first, and daily copies are not touched by it', () => {
    const dailies = [1, 2].map((d) => daily(day(d)));
    put(mig(1, day(-3)), mig(2, day(-2)), mig(3, day(-1)), mig(4, day(10)), ...dailies);
    const written = backupDatabase(db, 5, NOW);
    expect(files().filter((n) => /backup-v\d/.test(n))).toEqual(
      [mig(2, day(-2)), mig(3, day(-1)), written.split('/').pop()].sort(),
    );
    for (const d of dailies) expect(files()).toContain(d);
  });

  it('daily keep-7 holds on a normal week', () => {
    for (let d = 0; d < 10; d += 1)
      backupDatabaseDaily(db, new Date(NOW.getTime() + d * 86_400_000));
    const left = files().filter((n) => n.includes('backup-daily'));
    expect(left).toHaveLength(7);
    expect(left[0]).toBe(daily(day(3)));
  });
});

describe('B52 hasDailyBackupOn probes', () => {
  it.each([
    ['earlier today', day(0, '000000'), true],
    ['exactly now', day(0, '030000'), true],
    ['later today (clock was ahead)', day(0, '030001'), false],
    ['tomorrow', day(1, '000000'), false],
    ['yesterday', day(-1, '235959'), false],
  ])('%s', (_label, at, expected) => {
    put(daily(at));
    expect(hasDailyBackupOn(db, NOW)).toBe(expected);
  });

  it('uses the UTC day: 23:30Z counts a 23:00Z copy of the same UTC day', () => {
    const late = new Date('2026-11-24T23:30:00.000Z');
    put(daily('20261124T230000Z'));
    expect(hasDailyBackupOn(db, late)).toBe(true);
    expect(hasDailyBackupOn(db, new Date('2026-11-25T00:10:00.000Z'))).toBe(false);
  });

  it('clock back then forward: a real day gets a copy, and no duplicate after it', async () => {
    put(daily(day(0, '120000'))); // written while the clock was ~9h ahead
    let at = NOW;
    const backup = createDailyBackup({
      db,
      now: () => at,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await backup.run();
    await backup.run();
    const today = files().filter((n) =>
      n.startsWith(`anomander.db.backup-daily-${day(0).slice(0, 8)}`),
    );
    // The copy stamped ahead was the only other one, so nothing showed the clock was right: kept.
    expect(today).toEqual([daily(day(0)), daily(day(0, '120000'))]);
    at = new Date(NOW.getTime() + 3_600_000);
    await backup.run();
    expect(files().filter((n) => n.includes('backup-daily'))).toHaveLength(2);
    // By the next day its stamp has passed: it is an ordinary older copy of a day that already
    // has its real one, kept by the usual rule.
    at = new Date(NOW.getTime() + 86_400_000);
    await backup.run();
    expect(files().filter((n) => n.includes('backup-daily'))).toEqual([
      daily(day(0)),
      daily(day(0, '120000')),
      daily(day(1)),
    ]);
  });

  it('a future copy never outlives its stamp to stand for that day', async () => {
    put(daily(day(3, '010000'))); // clock was 3 days ahead once
    let at = NOW;
    const backup = createDailyBackup({
      db,
      now: () => at,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    for (let d = 0; d <= 3; d += 1) {
      at = new Date(NOW.getTime() + d * 86_400_000); // 03:00Z each day
      await backup.run();
    }
    // Day +3 at 03:00Z holds the copy written then, not the stale one stamped 01:00Z that day
    // (really written before day 0).
    const day3 = files().filter((n) => n.includes(`backup-daily-${day(3).slice(0, 8)}`));
    expect(day3).toEqual([daily(day(3))]);
  });
});

describe('B52 export probes', () => {
  it('refuses an in-memory store and writes nothing in the folder it is given', () => {
    // `/exportar` passes `dirname(':memory:')`, the current folder; the refusal comes before the
    // folder is used, so any folder proves it, without changing the process's current folder.
    const mem = openDatabase(':memory:');
    applyMigrations(mem);
    try {
      const before = files();
      expect(() => exportLedger(mem, scratch, NOW)).toThrow(InMemoryStoreError);
      expect(files()).toEqual(before);
    } finally {
      mem.close();
    }
  });

  it('error carries no path', () => {
    const e = new InMemoryStoreError();
    expect(e.name).toBe('InMemoryStoreError');
    expect((e as NodeJS.ErrnoException).code).toBeUndefined();
  });
});
