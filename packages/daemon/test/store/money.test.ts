import { describe, expect, it } from 'vitest';
import { parsePorMoneda } from '../../src/store/money.ts';

// B78: `pendientes_de_confirmar.por_moneda` (B71) is a JSON array kept as text by SQLite; the
// read API, the Gastos screen and `/exportar` read it through this one parser.
describe('por_moneda', () => {
  it('reads the JSON text of the view as the array it holds', () => {
    expect(
      parsePorMoneda(
        '[{"moneda":"EUR","cantidad":2,"total_cents":4520},{"moneda":"USD","cantidad":1,"total_cents":1200}]',
      ),
    ).toEqual([
      { moneda: 'EUR', cantidad: 2, total_cents: 4520 },
      { moneda: 'USD', cantidad: 1, total_cents: 1200 },
    ]);
  });

  it('reads an empty array, and a missing value, as no currency', () => {
    expect(parsePorMoneda('[]')).toEqual([]);
    expect(parsePorMoneda(null)).toEqual([]);
    expect(parsePorMoneda(undefined)).toEqual([]);
  });
});
