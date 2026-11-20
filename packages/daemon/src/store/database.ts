import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabase } from './backup.ts';

// Versioned SQL files applied at startup (PRD §13). Resolved from this module, so the
// same path works locally and in the Docker image (`/app/packages/daemon/migrations`).
export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations');

const NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * §16: the database is the principal's alone. A missing data folder is created with mode 700 and
 * a missing database file with mode 600 before SQLite opens it; SQLite gives its `-wal` and
 * `-shm` files the database file's mode. An existing folder or file keeps the mode it has.
 */
export const openDatabase = (path: string): Database.Database => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (path !== ':memory:' && !existsSync(path)) {
    const file = openSync(path, 'a', 0o600);
    try {
      // The umask can only remove bits; this makes 600 explicit whatever it is.
      fchmodSync(file, 0o600);
    } finally {
      closeSync(file);
    }
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // REPLACE removes the conflicting row without firing delete triggers unless this is on,
  // which would let it rewrite the append-only assertions ledger (R-7 AC3).
  db.pragma('recursive_triggers = ON');
  // Deleted content is overwritten with zeros, so a forgotten memory leaves no text in free
  // pages (R-23 AC7).
  db.pragma('secure_delete = ON');
  return db;
};

// `0007_read_views` → 7. Only the number is ever shown, never other text from the database.
const versionNumber = (version: string): number => Number.parseInt(version, 10) || 0;

const appliedVersions = (db: Database.Database): string[] => {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (table === undefined) return [];
  return db
    .prepare<[], { version: string }>('SELECT version FROM schema_migrations')
    .all()
    .map((row) => row.version);
};

export interface MigrationOptions {
  /** The time the backup taken before pending migrations is named after. */
  now?: () => Date;
}

// Applies every `.sql` file in filename order that is not yet recorded. Each file runs in
// its own transaction together with its version row, so a failure leaves no trace of it.
// Returns how many files were applied.
//
// A database holding a version this build does not know is refused before anything is
// written. A database that already holds migrations is first copied beside its file (see
// `backupDatabase`); a fresh one is not, and a failed copy applies nothing.
export const applyMigrations = (
  db: Database.Database,
  dir: string = MIGRATIONS_DIR,
  { now = () => new Date() }: MigrationOptions = {},
): number => {
  const known = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const knownVersions = new Set(known.map((file) => basename(file, '.sql')));
  const newestKnown = versionNumber(known.at(-1) ?? '');
  const applied = appliedVersions(db);
  const unknown = applied.filter((version) => !knownVersions.has(version));
  if (unknown.length > 0) {
    const newest = Math.max(...unknown.map(versionNumber));
    // A lower unknown version is a migration this build does not have under that name.
    throw new Error(
      newest > newestKnown
        ? `the database is at migration version ${newest}, newer than this build knows (${newestKnown}); ` +
            'it was left untouched: update ANOMANDER to open it'
        : `the database records migration version ${newest}, which this build does not know; ` +
            'it was left untouched',
    );
  }
  const pending = known.filter((file) => !applied.includes(basename(file, '.sql')));

  if (pending.length > 0 && applied.length > 0 && db.name !== ':memory:') {
    const from = Math.max(...applied.map(versionNumber));
    try {
      backupDatabase(db, from, now());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`backup before migrations failed, nothing was applied: ${reason}`, {
        cause: error,
      });
    }
  }

  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const record = db.prepare<[string]>(
    `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ${NOW_UTC})`,
  );

  for (const file of pending) {
    const sql = readFileSync(resolve(dir, file), 'utf8');
    try {
      db.transaction(() => {
        db.exec(sql);
        record.run(basename(file, '.sql'));
      })();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${file} failed: ${reason}`, { cause: error });
    }
  }
  return pending.length;
};
