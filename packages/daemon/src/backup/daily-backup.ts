import type Database from 'better-sqlite3';
import type { Logger } from '../processor/ports.ts';
import { backupDatabaseDaily, hasDailyBackupOn } from '../store/backup.ts';

// B5: the daily copy of the database. The scheduler runs it right after the retention job, at
// startup and at `ANOMANDER_RETENTION_CRON`, so a copy never holds what retention already erased
// (§16). A restart the same day makes no second copy; a failure is logged and the copy is made at
// the next run.

export interface DailyBackupDeps {
  db: Database.Database;
  now: () => Date;
  logger: Logger;
}

export interface DailyBackup {
  /** Writes today's copy unless it exists. Never rejects. */
  run(): Promise<void>;
}

export const createDailyBackup = ({ db, now, logger }: DailyBackupDeps): DailyBackup => ({
  run: async () => {
    // An in-memory database has no folder to copy into.
    if (db.memory) return;
    try {
      const at = now();
      if (!hasDailyBackupOn(db, at)) backupDatabaseDaily(db, at);
    } catch (error) {
      // The error's message names the file, and the path may name the principal: only its code.
      const code = (error as NodeJS.ErrnoException).code;
      logger.error('daily backup failed; it is tried again at the next run', {
        reason: code ?? (error instanceof Error ? error.name : 'unknown'),
      });
    }
  },
});
