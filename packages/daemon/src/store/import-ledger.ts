import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { acquireDaemonLock, DaemonAlreadyRunningError, type DaemonLock } from './daemon-lock.ts';
import { MIGRATIONS_DIR } from './database.ts';

// DK-12 (desktop next, S4): a ledger brought from a Docker install (`docker cp`) becomes the
// app's own. Run by the desktop shell with the daemon stopped (`scripts/import-ledger.ts`).
//
// The source is never opened by SQLite: its bytes, and its `-wal` when there is one, are copied
// first and only the copy is read, so nothing next to the source changes. The app's own ledger is
// replaced only while it holds no expense, and it is moved aside, never deleted.

/** Why a ledger was not imported: the words the script prints, which the shell knows. */
export type Refusal =
  | 'missing'
  | 'same_file'
  | 'not_a_ledger'
  | 'newer_ledger'
  | 'damaged'
  | 'daemon_running'
  | 'own_has_expenses';

export type ImportOutcome = { kind: 'imported' } | { kind: 'refused'; reason: Refusal };

export interface ImportOptions {
  now?: () => Date;
  migrationsDir?: string;
}

const JOURNALS = ['-wal', '-shm'] as const;

class Refused extends Error {
  readonly reason: Refusal;
  constructor(reason: Refusal) {
    super(reason);
    this.reason = reason;
  }
}

const removeWithJournals = (path: string): void => {
  for (const suffix of ['', ...JOURNALS]) rmSync(`${path}${suffix}`, { force: true });
};

/** `20261118-102030`, in UTC. */
const stampOf = (date: Date): string =>
  date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/** A name next to `own` that no file has, with or without a journal suffix. */
const asideName = (own: string, now: Date): string => {
  const base = `${own}.before-import-${stampOf(now)}`;
  const free = (path: string) =>
    ['', ...JOURNALS].every((suffix) => !existsSync(`${path}${suffix}`));
  if (free(base)) return base;
  for (let n = 2; ; n += 1) {
    if (free(`${base}-${n}`)) return `${base}-${n}`;
  }
};

/** Whether the app's own ledger holds an expense. A ledger without the table holds none. */
const holdsExpenses = (own: string): boolean => {
  // Read-write, so closing it leaves no journal file behind.
  const db = new Database(own, { fileMustExist: true });
  try {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'expenses'")
      .get();
    return table !== undefined && db.prepare('SELECT 1 FROM expenses LIMIT 1').get() !== undefined;
  } finally {
    db.close();
  }
};

/** Checks the copy is an ANOMANDER ledger this build can migrate, whole, and folds its journal. */
const check = (copy: string, migrationsDir: string): void => {
  let db: Database.Database;
  try {
    db = new Database(copy, { fileMustExist: true });
  } catch {
    throw new Refused('not_a_ledger');
  }
  try {
    const known = new Set(
      readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .map((file) => basename(file, '.sql')),
    );
    let versions: string[];
    try {
      const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
      if (table === undefined) throw new Refused('not_a_ledger');
      versions = db
        .prepare<[], { version: string }>('SELECT version FROM schema_migrations')
        .all()
        .map((row) => row.version);
    } catch (error) {
      if (error instanceof Refused) throw error;
      throw new Refused(corrupt(error) ? 'damaged' : 'not_a_ledger');
    }
    if (!versions.includes('0001_initial')) throw new Refused('not_a_ledger');
    if (versions.some((version) => !known.has(version))) throw new Refused('newer_ledger');
    try {
      const result = db.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Refused('damaged');
      // The rows still in the journal go into the file, which then stands alone.
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      if (error instanceof Refused) throw error;
      throw new Refused('damaged');
    }
  } finally {
    db.close();
  }
};

const corrupt = (error: unknown): boolean =>
  (error as { code?: unknown }).code === 'SQLITE_CORRUPT';

/** Moves `from` and its journal files to `to`. */
const moveWithJournals = (from: string, to: string): void => {
  for (const suffix of ['', ...JOURNALS]) {
    if (existsSync(`${from}${suffix}`)) renameSync(`${from}${suffix}`, `${to}${suffix}`);
  }
};

/**
 * Makes the ledger at `source` the app's own at `own`. Every refusal and every failure leaves
 * `own` as it was; an error that is not a refusal is thrown after cleaning up.
 */
export const importLedger = (
  source: string,
  own: string,
  options: ImportOptions = {},
): ImportOutcome => {
  const { now = () => new Date(), migrationsDir = MIGRATIONS_DIR } = options;
  const copy = join(dirname(own), `.${basename(own)}.import`);
  let lock: DaemonLock | undefined;
  try {
    const found = statSync(source, { throwIfNoEntry: false });
    if (found === undefined || !found.isFile()) throw new Refused('missing');
    const ownFound = statSync(own, { throwIfNoEntry: false });
    if (ownFound !== undefined && ownFound.dev === found.dev && ownFound.ino === found.ino) {
      throw new Refused('same_file');
    }
    // Held to the end: a daemon that starts meanwhile stops at the lock, before the ledger.
    try {
      lock = acquireDaemonLock(own);
    } catch (error) {
      if (error instanceof DaemonAlreadyRunningError) throw new Refused('daemon_running');
      throw error;
    }
    if (ownFound !== undefined && holdsExpenses(own)) throw new Refused('own_has_expenses');

    removeWithJournals(copy);
    copyFileSync(source, copy);
    // The folder is the principal's alone; the file is made so as well (PRD §16).
    chmodSync(copy, 0o600);
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${copy}-wal`);
    check(copy, migrationsDir);
    for (const suffix of JOURNALS) rmSync(`${copy}${suffix}`, { force: true });
  } catch (error) {
    removeWithJournals(copy);
    lock?.release();
    if (error instanceof Refused) return { kind: 'refused', reason: error.reason };
    throw error;
  }

  const aside = existsSync(own) ? asideName(own, now()) : null;
  try {
    if (aside !== null) moveWithJournals(own, aside);
    renameSync(copy, own);
  } catch (error) {
    // The app's own ledger goes back where it was.
    if (aside !== null && !existsSync(own)) moveWithJournals(aside, own);
    removeWithJournals(copy);
    throw error;
  } finally {
    lock.release();
  }
  return { kind: 'imported' };
};
