import Database from 'better-sqlite3';

// RA-2 AC6: every query readers run, in one place, so the read API and the later MCP server
// serve the same rows. They read only the views of RA-1, never the tables (read access §4).

/** A day as `expenses.occurred_on` stores it: `YYYY-MM-DD` in `TZ`. */
export type Day = string;

/** A row of `gastos`. */
export interface Gasto {
  id: number;
  fecha: Day;
  comercio: string | null;
  categoria: string | null;
  total_cents: number;
  modo: string;
  origen: 'texto' | 'ticket';
}

/** A row of `lineas_de_compra`. */
export interface LineaDeCompra {
  gasto_id: number;
  producto: string;
  cantidad: number;
  precio_cents: number;
  comercio: string | null;
  categoria: string | null;
  fecha: Day;
  modo: string;
}

/** The one row of `pendientes_de_confirmar`. */
export interface Pendientes {
  cantidad: number;
  total_cents: number;
}

/** Both days inclusive. */
export interface DayRange {
  desde: Day;
  hasta: Day;
}

/**
 * The connection readers use: read-only, so no reader can write even by mistake (RA-G3). It
 * needs the file and its migrations to exist already.
 */
export const openReadOnly = (path: string): Database.Database =>
  new Database(path, { readonly: true, fileMustExist: true });

/** `true` for a real calendar day written `YYYY-MM-DD`. */
export const isDay = (value: string | null): value is Day => {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

/** Current expenses from `desde` to `hasta`, by day and then id. */
export const readGastos = (db: Database.Database, { desde, hasta }: DayRange): Gasto[] =>
  db
    .prepare<[Day, Day], Gasto>(
      'SELECT * FROM gastos WHERE fecha BETWEEN ? AND ? ORDER BY fecha, id',
    )
    .all(desde, hasta);

/**
 * Purchase lines of current expenses from `desde` to `hasta`, by day, expense and product.
 * `producto` keeps only the lines whose product is exactly it, as printed on the receipt.
 */
export const readLineas = (
  db: Database.Database,
  { desde, hasta, producto }: DayRange & { producto?: string },
): LineaDeCompra[] =>
  producto === undefined
    ? db
        .prepare<[Day, Day], LineaDeCompra>(
          `SELECT * FROM lineas_de_compra WHERE fecha BETWEEN ? AND ?
           ORDER BY fecha, gasto_id, producto`,
        )
        .all(desde, hasta)
    : db
        .prepare<[Day, Day, string], LineaDeCompra>(
          `SELECT * FROM lineas_de_compra WHERE fecha BETWEEN ? AND ? AND producto = ?
           ORDER BY fecha, gasto_id, producto`,
        )
        .all(desde, hasta, producto);

/** How many expenses are pending and their total; `0` and `0` when none is. */
export const readPendientes = (db: Database.Database): Pendientes => {
  const sql = 'SELECT cantidad, total_cents FROM pendientes_de_confirmar';
  // The view always has its one row; the fallback only satisfies the type.
  return db.prepare<[], Pendientes>(sql).get() ?? { cantidad: 0, total_cents: 0 };
};
