// B71: `pendientes_de_confirmar` keeps its pending expenses per currency in `por_moneda`, a JSON
// array SQLite hands over as text. B78: the read API, the Gastos screen and `/exportar` read it
// through this one parser, so they never disagree on its shape.

/** The pending expenses of one currency. */
export interface PendientesEnMoneda {
  moneda: string;
  cantidad: number;
  total_cents: number;
}

/** `por_moneda` as the array it holds; a missing value is no currency. */
export const parsePorMoneda = (text: unknown): PendientesEnMoneda[] =>
  text === null || text === undefined ? [] : (JSON.parse(String(text)) as PendientesEnMoneda[]);
