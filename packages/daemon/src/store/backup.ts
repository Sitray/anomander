import { closeSync, fchmodSync, openSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

// How many backups taken before migrations stay beside the database; older ones are deleted.
export const KEPT_BACKUPS = 3;
// How many daily copies (B5) stay beside it, apart from the ones taken before migrations.
export const KEPT_DAILY_BACKUPS = 7;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `20261120T153000Z`: the UTC second, sortable as text.
export const stamp = (at: Date): string => `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

/**
 * Writes a copy of `db` beside its file, as `<file>.backup-v<version>-<yyyymmddThhmmssZ>`, with
 * mode 600 (§16), then deletes all but the `keep` newest files with that name pattern. Returns
 * the backup's path. Throws, leaving no partial copy, when the copy cannot be written.
 */
export const backupDatabase = (
  db: Database.Database,
  fromVersion: number,
  now: Date,
  keep: number = KEPT_BACKUPS,
): string => writeBackup(db, `v${fromVersion}`, 'v\\d+', now, keep);

/**
 * B5: the daily copy, `<file>.backup-daily-<yyyymmddThhmmssZ>`, written as `backupDatabase` writes
 * its own; only daily copies are pruned to the `keep` newest. Throws as `backupDatabase` does.
 */
export const backupDatabaseDaily = (
  db: Database.Database,
  now: Date,
  keep: number = KEPT_DAILY_BACKUPS,
): string => writeBackup(db, 'daily', 'daily', now, keep);

/**
 * Whether a daily copy of `db` stamped on the UTC day of `now` is already beside it. A copy
 * stamped after `now`, by a clock that was once ahead, does not count (B52): it would otherwise
 * stand for a real day that never got its copy.
 */
export const hasDailyBackupOn = (db: Database.Database, now: Date): boolean => {
  const at = stamp(now);
  const day = at.slice(0, 8);
  const pattern = namePattern(basename(db.name), 'daily');
  return readdirSync(dirname(db.name)).some((name) => {
    const stamped = pattern.exec(name)?.[1];
    return stamped?.startsWith(day) && stamped <= at;
  });
};

// `<file>.backup-<label>-<stamp>[-n]`, where `label` matches the regular expression `labels`.
const namePattern = (file: string, labels: string): RegExp =>
  new RegExp(`^${escapeRegExp(file)}\\.backup-${labels}-(\\d{8}T\\d{6}Z)(?:-(\\d+))?$`);

const writeBackup = (
  db: Database.Database,
  label: string,
  labels: string,
  now: Date,
  keep: number,
): string => {
  const folder = dirname(db.name);
  const file = basename(db.name);
  const base = `${file}.backup-${label}-${stamp(now)}`;
  // A second start within the same second gets `-1`, `-2`, … rather than failing.
  let target = join(folder, base);
  let handle: number | undefined;
  for (let n = 1; handle === undefined; n += 1) {
    try {
      // Created empty with mode 600 first, so the copy is never readable by others.
      handle = openSync(target, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      target = join(folder, `${base}-${n}`);
    }
  }
  try {
    fchmodSync(handle, 0o600);
  } finally {
    closeSync(handle);
  }
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
  prune(folder, namePattern(file, labels), keep, basename(target), stamp(now));
  return target;
};

// Only files named exactly as backups of this database are ever deleted, and never `written`, the
// one just made. Copies stamped after `now`, by a clock that was once ahead, go first (B52): their
// stamp says nothing of their real age, and sorted by it they would outlive every real copy. Then
// the oldest. A failure to delete an old backup does not stop the start.
const prune = (
  folder: string,
  pattern: RegExp,
  keep: number,
  written: string,
  now: string,
): void => {
  const found = readdirSync(folder)
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry) => entry.match !== null && entry.name !== written)
    .map(({ name, match }) => {
      const at = match?.[1] ?? '';
      return { name, at, ahead: at > now, n: Number(match?.[2] ?? 0) };
    })
    .sort((a, b) =>
      a.ahead !== b.ahead ? (a.ahead ? -1 : 1) : a.at === b.at ? a.n - b.n : a.at < b.at ? -1 : 1,
    );
  for (const { name } of found.slice(0, Math.max(0, found.length - (keep - 1)))) {
    try {
      rmSync(join(folder, name), { force: true });
    } catch {
      // Left for the next start to delete.
    }
  }
};
