import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isLiteralAmount, literalAmountsInCents } from '../src/index.ts';

// R-2 AC5 and AC6: the amount forms the principal writes, normalized to integer cents.
describe('literalAmountsInCents', () => {
  it.each([
    ['23 cena', 2300],
    ['23,40 Mercadona', 2340],
    ['23.40 Mercadona', 2340],
    ['23€ cena', 2300],
    ['23 € cena', 2300],
    ['€23 cena', 2300],
  ])('reads %j as %i cents', (text, cents) => {
    expect(literalAmountsInCents(text)).toEqual([cents]);
    expect(isLiteralAmount(text, cents)).toBe(true);
  });

  it('finds any amount written in any AC5 form inside surrounding words', () => {
    const word = fc.stringMatching(/^[a-záéíóúñ]{1,8}$/);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 99 }),
        fc.constantFrom('', ',', '.'),
        fc.constantFrom('', '€', ' €', '€prefix'),
        fc.array(word, { maxLength: 3 }),
        fc.array(word, { maxLength: 3 }),
        (euros, fraction, separator, currency, before, after) => {
          const decimals =
            separator === '' ? '' : `${separator}${String(fraction).padStart(2, '0')}`;
          const number = `${euros}${decimals}`;
          const amount = currency === '€prefix' ? `€${number}` : `${number}${currency}`;
          const text = [...before, amount, ...after].join(' ');
          const cents = euros * 100 + (separator === '' ? 0 : fraction);
          expect(literalAmountsInCents(text)).toContain(cents);
        },
      ),
    );
  });
});
