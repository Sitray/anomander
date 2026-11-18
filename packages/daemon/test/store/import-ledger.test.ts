import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireDaemonLock } from '../../src/store/daemon-lock.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { importLedger } from '../../src/store/import-ledger.ts';

// DK-12 (desktop next, S4): a ledger brought from a Docker install replaces the app's empty one.
// The source is never written, and the app's own file is never deleted.

const NOW = new Date('2026-11-18T10:20:30Z');
const STAMP = '20261118-102030';
const SCRIPT = resolve(import.meta.dirname, '../../scripts/import-ledger.ts');

let scratch: string;
let data: string;
let own: string;
let source: string;

/** A migrated ledger at `path`, closed, with `expenses` expenses in it. */
const ledger = (path: string, expenses: number): void => {
  const db = openDatabase(path);
  applyMigrations(db);
  for (let i = 0; i < expenses; i += 1) {
    db.prepare(
      `INSERT INTO expenses (occurred_on, total_cents, mode, status, created_at)
       VALUES ('2026-09-01', ?, 'declared', 'current', '2026-09-01T10:00:00.000Z')`,
    ).run(100 + i);
  }
  db.close();
};

const expensesIn = (path: string): number[] => {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare<[], { total_cents: number }>('SELECT total_cents FROM expenses ORDER BY id')
      .all()
      .map((row) => row.total_cents);
  } finally {
    db.close();
  }
};

/** The files of a folder, without the daemon's lock (DK-2), which the import takes as it does. */
const files = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => !name.includes('.lock'))
    .sort();

/** Every file of the data folder with its bytes, to prove nothing changed. */
const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(
    files(dir).map((name) => [name, readFileSync(join(dir, name)).toString('base64')]),
  );

const run = (...args: string[]) =>
  promisify(execFile)(process.execPath, [SCRIPT, ...args]).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }),
  );

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-import-'));
  data = join(scratch, 'data');
  mkdirSync(data, { mode: 0o700 });
  own = join(data, 'anomander.db');
  mkdirSync(join(scratch, 'docker'));
  source = join(scratch, 'docker', 'anomander.db');
  ledger(source, 3);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('importing a ledger', () => {
  it('copies it into an app that has none, private, and leaves the source as it was', async () => {
    const before = readFileSync(source);

    expect(await importLedger(source, own, { now: () => NOW })).toEqual({ kind: 'imported' });

    expect(files(data)).toEqual(['anomander.db']);
    expect(readdirSync(join(scratch, 'docker'))).toEqual(['anomander.db']);
    expect(statSync(own).mode & 0o777).toBe(0o600);
    expect(readFileSync(source).equals(before)).toBe(true);
    expect(expensesIn(own)).toEqual([100, 101, 102]);
    // The daemon opens it and migrates it as its own.
    const db = openDatabase(own);
    applyMigrations(db);
    db.close();
  });

  it('keeps an empty ledger of the app aside under a dated name', async () => {
    ledger(own, 0);
    const kept = snapshot(data);

    expect(await importLedger(source, own, { now: () => NOW })).toEqual({ kind: 'imported' });

    const aside = `anomander.db.before-import-${STAMP}`;
    expect(files(data)).toEqual(['anomander.db', aside]);
    expect(readFileSync(join(data, aside)).toString('base64')).toBe(kept['anomander.db']);
    expect(expensesIn(own)).toEqual([100, 101, 102]);
  });

  it('keeps aside the journal files a missing ledger left, so none is read into the copy', async () => {
    // A ledger deleted by hand, with its journal left: SQLite would read it into the new file.
    ledger(own, 0);
    const db = openDatabase(own);
    db.pragma('wal_autocheckpoint = 0');
    db.prepare(
      `INSERT INTO expenses (occurred_on, total_cents, mode, status, created_at)
       VALUES ('2026-09-03', 4242, 'declared', 'current', '2026-09-03T10:00:00.000Z')`,
    ).run();
    const wal = readFileSync(`${own}-wal`);
    db.close();
    rmSync(own);
    writeFileSync(`${own}-wal`, wal);

    expect(await importLedger(source, own, { now: () => NOW })).toEqual({ kind: 'imported' });

    const aside = `anomander.db.before-import-${STAMP}`;
    expect(files(data)).toEqual(['anomander.db', `${aside}-wal`]);
    expect(readFileSync(join(data, `${aside}-wal`)).equals(wal)).toBe(true);
    expect(expensesIn(own)).toEqual([100, 101, 102]);
  });

  it('never writes over a ledger kept aside before', async () => {
    ledger(own, 0);
    writeFileSync(join(data, `anomander.db.before-import-${STAMP}`), 'older');

    expect(await importLedger(source, own, { now: () => NOW })).toEqual({ kind: 'imported' });

    expect(readFileSync(join(data, `anomander.db.before-import-${STAMP}`), 'utf8')).toBe('older');
    expect(existsSync(join(data, `anomander.db.before-import-${STAMP}-2`))).toBe(true);
  });

  it('brings the expenses still in the source journal', async () => {
    // A copy taken while its daemon ran: part of the ledger is still in `-wal`.
    const db = openDatabase(source);
    db.pragma('wal_autocheckpoint = 0');
    db.prepare(
      `INSERT INTO expenses (occurred_on, total_cents, mode, status, created_at)
       VALUES ('2026-09-02', 999, 'declared', 'current', '2026-09-02T10:00:00.000Z')`,
    ).run();
    const copy = join(scratch, 'copy');
    mkdirSync(copy);
    writeFileSync(join(copy, 'anomander.db'), readFileSync(source));
    writeFileSync(join(copy, 'anomander.db-wal'), readFileSync(`${source}-wal`));
    db.close();
    const before = snapshot(copy);

    expect(await importLedger(join(copy, 'anomander.db'), own, { now: () => NOW })).toEqual({
      kind: 'imported',
    });

    expect(expensesIn(own)).toEqual([100, 101, 102, 999]);
    expect(snapshot(copy)).toEqual(before);
  });
});

describe('what it refuses, leaving everything as it was', () => {
  const refused = async (reason: string, from = source) => {
    const ownBefore = existsSync(data) ? snapshot(data) : {};
    const sourceBefore = statSync(from, { throwIfNoEntry: false })?.isFile()
      ? readFileSync(from)
      : null;

    expect(await importLedger(from, own, { now: () => NOW })).toEqual({ kind: 'refused', reason });

    expect(snapshot(data)).toEqual(ownBefore);
    if (sourceBefore !== null) expect(readFileSync(from).equals(sourceBefore)).toBe(true);
  };

  it('a ledger a daemon is using', async () => {
    ledger(own, 0);
    const lock = acquireDaemonLock(own);
    try {
      await refused('daemon_running');
    } finally {
      lock.release();
    }
  });

  it('an app whose ledger already holds an expense', async () => {
    ledger(own, 1);
    await refused('own_has_expenses');
  });

  it('a file that is not there, or a folder', async () => {
    await refused('missing', join(scratch, 'nothing.db'));
    await refused('missing', join(scratch, 'docker'));
  });

  it('the app’s own ledger, also through a link', async () => {
    ledger(own, 0);
    await refused('same_file', own);
    const link = join(scratch, 'link.db');
    symlinkSync(own, link);
    await refused('same_file', link);
  });

  it('a file that is not a database', async () => {
    const text = join(scratch, 'notes.txt');
    writeFileSync(text, 'not a ledger at all, just some text that is long enough to read');
    await refused('not_a_ledger', text);
  });

  it('a database that is not an ANOMANDER ledger', async () => {
    const other = join(scratch, 'other.db');
    const db = new Database(other);
    db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY)');
    db.close();
    await refused('not_a_ledger', other);
  });

  it('a ledger from a newer build, with a migration this one does not know', async () => {
    const db = new Database(source);
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES ('9999_future', 'x')",
    ).run();
    db.close();
    await refused('newer_ledger');
  });

  it('a damaged ledger', async () => {
    const bytes = readFileSync(source);
    const pageSize = bytes.readUInt16BE(16);
    // Every page but the first, which names the tables, is overwritten.
    bytes.fill(0xff, pageSize);
    writeFileSync(source, bytes);
    await refused('damaged');
  });
});

describe('the script the app runs', () => {
  it('says "imported" and ends with 0', async () => {
    expect(await run(source, own)).toEqual({ code: 0, stdout: 'imported\n' });
    expect(expensesIn(own)).toEqual([100, 101, 102]);
  });

  it('says why it refused in one word, and ends with 0', async () => {
    ledger(own, 1);
    expect(await run(source, own)).toEqual({ code: 0, stdout: 'own_has_expenses\n' });
  });

  it('ends with 2 without its two paths', async () => {
    expect((await run(source)).code).toBe(2);
  });
});
