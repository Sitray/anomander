import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../src/locale.ts';
import { isCurrency, setCurrency } from '../src/money.ts';
import { formatAmount, strings } from '../src/strings.ts';

// DK-25 (B15): one shared formatter says every amount in its own currency, in the language of
// the moment, and a sum that holds more than one currency is said per currency, never added.

afterEach(() => {
  setLocale('es');
  setCurrency('EUR');
});

describe('amounts in their currency', () => {
  it('says an amount in its own currency with the language format', () => {
    expect(formatAmount({ cents: 1230, currency: 'EUR' })).toBe('12,30 €');
    expect(formatAmount({ cents: 1230, currency: 'USD' })).toBe('12,30 US$');
    setLocale('en');
    expect(formatAmount({ cents: 1230, currency: 'EUR' })).toBe('€12.30');
    expect(formatAmount({ cents: 1230, currency: 'USD' })).toBe('US$12.30');
  });

  it('says bare cents in the principal currency, euros until one is chosen', () => {
    expect(formatAmount(2340)).toBe('23,40 €');
    setCurrency('USD');
    expect(formatAmount(2340)).toBe('23,40 US$');
    expect(strings.whichExpense()).toBe(
      '¿Qué gasto corrijo? Dímelo con su importe, por ejemplo: el de 23,40 US$.',
    );
  });

  it('says a sum of several currencies per currency, the principal one first', () => {
    const sum = [
      { cents: 1200, currency: 'USD' },
      { cents: 4520, currency: 'EUR' },
    ];
    expect(formatAmount(sum)).toBe('45,20 € y 12,00 US$');
    setLocale('en');
    expect(formatAmount(sum)).toBe('€45.20 and US$12.00');
    expect(formatAmount([])).toBe('€0.00');
  });

  it('knows ISO 4217 codes only, in upper case', () => {
    expect(isCurrency('USD')).toBe(true);
    expect(isCurrency('usd')).toBe(false);
    expect(isCurrency('XYZ')).toBe(false);
    expect(() => setCurrency('XYZ')).toThrow('not an ISO 4217 currency: XYZ');
  });
});
