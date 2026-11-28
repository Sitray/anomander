import { closeSync, fchmodSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { stamp } from './backup.ts';
import { parsePorMoneda } from './money.ts';

// B5: the principal's ledger as files they can keep or open in a spreadsheet: the read views of
// RA-1 (`docs/read-access-prd.md`), one CSV file each and all of them in `ledger.json`, in
// `<data folder>/exports/<yyyymmddThhmmssZ>/`. Folders get mode 700 and files mode 600 (§16). No
// processor is involved.

/**
 * The views exported, in this order. `pendientes_de_confirmar` always has one row; its
 * `por_moneda` is a JSON array (B71), kept as text in the CSV file and as an array in `ledger.json`.
 */
export const EXPORTED_VIEWS = ['gastos', 'lineas_de_compra', 'pendientes_de_confirmar'] as const;

export interface LedgerExport {
  /** The dated folder written. */
  folder: string;
  /** Its files: one `<view>.csv` per view, then `ledger.json`. */
  files: string[];
}

type Row = Record<string, unknown>;

// A text a spreadsheet would run as a formula starts with one of these; it gets a leading `'`.
// B54: also behind spaces, which an import may trim, and as the full-width signs, which a
// spreadsheet may read as the ASCII ones. B86: also behind zero-width and other format characters
// (`\p{Cf}`: U+200B-U+200D, U+2060, U+FEFF, …), which an import may drop, and as the small-form
// signs (U+FE62, U+FE63, U+FE66, U+FE6B) and the minus sign U+2212. B89: also behind the
// next-line character U+0085, which `\s` leaves out, and as the figure and en dashes U+2012, U+2013.
const FORMULA_START =
  /^[\t\r]|^[\s\p{Cf}\u0085]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20\uFE66\uFE62\uFE63\uFE6B\u2212\u2012\u2013]/u;

const csvField = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) || text !== value ? `"${text.replaceAll('"', '""')}"` : text;
};

// RFC 4180: CRLF line ends, a header row with the view's columns even when it has no rows.
const toCsv = (columns: string[], rows: Row[]): string =>
  [columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((fields) => `${fields.map(csvField).join(',')}\r\n`)
    .join('');

/** The one row of `pendientes_de_confirmar` with its `por_moneda` read as the array it holds. */
const pendientes = (row: Row | undefined): Row | undefined =>
  row === undefined ? row : { ...row, por_moneda: parsePorMoneda(row.por_moneda) };

/** Creates `path` empty with mode 600, then writes `text`; never overwrites a file. */
const writePrivate = (path: string, text: string): void => {
  const handle = openSync(path, 'wx', 0o600);
  try {
    fchmodSync(handle, 0o600);
    writeSync(handle, text);
  } finally {
    closeSync(handle);
  }
};

/** A new dated folder under `exports`, `-1`, `-2`, … when one of that second already exists. */
const newFolder = (exportsDir: string, now: Date): string => {
  const base = join(exportsDir, stamp(now));
  for (let n = 0; ; n += 1) {
    const folder = n === 0 ? base : `${base}-${n}`;
    try {
      mkdirSync(folder, { mode: 0o700 });
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
};

/**
 * B52: an in-memory store (`ANOMANDER_DB_PATH=:memory:`) has no data folder, and the folder its
 * name points to is wherever the daemon was started from, so it is never exported.
 */
export class InMemoryStoreError extends Error {
  constructor() {
    super('an in-memory store has no data folder to export into');
    this.name = 'InMemoryStoreError';
  }
}

/**
 * Writes the export of `db` under `<dataDir>/exports/` and returns what it wrote. The views are
 * read in one transaction, so the files agree with each other. Throws, leaving no partial folder,
 * when a file cannot be written, and `InMemoryStoreError`, writing nothing, for an in-memory `db`.
 */
export const exportLedger = (db: Database.Database, dataDir: string, now: Date): LedgerExport => {
  if (db.memory) throw new InMemoryStoreError();
  const views = db.transaction(() =>
    EXPORTED_VIEWS.map((view) => {
      const statement = db.prepare(`SELECT * FROM ${view}`);
      return {
        view,
        columns: statement.columns().map((column) => column.name),
        rows: statement.all() as Row[],
      };
    }),
  )();
  const exportsDir = join(dataDir, 'exports');
  // An `exports` folder that already exists keeps its mode, as the data folder does (§16).
  mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
  const folder = newFolder(exportsDir, now);
  try {
    const files = views.map(({ view, columns, rows }) => {
      const path = join(folder, `${view}.csv`);
      writePrivate(path, toCsv(columns, rows));
      return path;
    });
    const ledger: Record<string, unknown> = { exported_at: now.toISOString() };
    for (const { view, rows } of views) {
      ledger[view] = view === 'pendientes_de_confirmar' ? pendientes(rows[0]) : rows;
    }
    const json = join(folder, 'ledger.json');
    writePrivate(json, `${JSON.stringify(ledger, null, 2)}\n`);
    return { folder, files: [...files, json] };
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
};
