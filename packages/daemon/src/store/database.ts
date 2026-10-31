import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

// Versioned SQL files applied at startup (PRD §13). Resolved from this module, so the
// same path works locally and in the Docker image (`/app/packages/daemon/migrations`).
export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations');

const NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const openDatabase = (path: string): Database.Database => {
  mkdirSync(dirname(path), { recursive: true });
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

// Applies every `.sql` file in filename order that is not yet recorded. Each file runs in
// its own transaction together with its version row, so a failure leaves no trace of it.
// Returns how many files were applied.
export const applyMigrations = (db: Database.Database, dir: string = MIGRATIONS_DIR): number => {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    db
      .prepare<[], { version: string }>('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version),
  );
  const record = db.prepare<[string]>(
    `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ${NOW_UTC})`,
  );
  const pending = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) => !applied.has(basename(file, '.sql')));

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
