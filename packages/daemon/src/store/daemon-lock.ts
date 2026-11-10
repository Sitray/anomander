import { closeSync, existsSync, fchmodSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// DK-2 AC1 (docs/desktop-prd.md): one daemon per database. The desktop app and Docker are two
// ways to run the same daemon, never both at once.

export class DaemonAlreadyRunningError extends Error {
  constructor(dbPath: string) {
    super(`another ANOMANDER daemon is already running on ${dbPath}`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

export interface DaemonLock {
  release(): void;
}

/**
 * Takes the lock of the database at `dbPath`, or throws `DaemonAlreadyRunningError` at once when
 * another daemon holds it. The lock is an exclusive SQLite transaction on `<dbPath>.lock`, held
 * for as long as the daemon runs: the operating system frees it when the process ends, however it
 * ends, so a crash never leaves a stale lock behind. The ledger itself is not opened.
 */
export const acquireDaemonLock = (dbPath: string): DaemonLock => {
  const path = `${dbPath}.lock`;
  // §16: as `openDatabase` does for the database, folder 700 and file 600.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const file = openSync(path, 'a', 0o600);
    try {
      fchmodSync(file, 0o600);
    } finally {
      closeSync(file);
    }
  }
  // `timeout: 0`: a held lock is an answer, not something to wait for.
  const lock = new Database(path, { timeout: 0 });
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') {
      throw new DaemonAlreadyRunningError(dbPath);
    }
    throw error;
  }
  return { release: () => lock.close() };
};
