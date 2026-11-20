import { closeSync, fchmodSync, openSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

// How many backups taken before migrations stay beside the database; older ones are deleted.
export const KEPT_BACKUPS = 3;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `20261120T153000Z`: the UTC second, sortable as text.
const stamp = (at: Date): string => `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

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
): string => {
  const folder = dirname(db.name);
  const file = basename(db.name);
  const base = `${file}.backup-v${fromVersion}-${stamp(now)}`;
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
  prune(folder, file, keep, basename(target));
  return target;
};

// Only files named exactly as backups of this database are ever deleted, oldest first, and never
// `written`, the one just made: older ones stamped by a clock that was once ahead would otherwise
// sort after it. A failure to delete an old backup does not stop the start.
const prune = (folder: string, file: string, keep: number, written: string): void => {
  const pattern = new RegExp(`^${escapeRegExp(file)}\\.backup-v\\d+-(\\d{8}T\\d{6}Z)(?:-(\\d+))?$`);
  const found = readdirSync(folder)
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry) => entry.match !== null && entry.name !== written)
    .map(({ name, match }) => ({
      name,
      at: match?.[1] ?? '',
      n: Number(match?.[2] ?? 0),
    }))
    .sort((a, b) => (a.at === b.at ? a.n - b.n : a.at < b.at ? -1 : 1));
  for (const { name } of found.slice(0, Math.max(0, found.length - (keep - 1)))) {
    try {
      rmSync(join(folder, name), { force: true });
    } catch {
      // Left for the next start to delete.
    }
  }
};
