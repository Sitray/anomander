import { getCurrency, getLocale, type Locale } from '@anomander/protocol';

// B73: the processor reads amounts in the principal's currency (`ANOMANDER_CURRENCY`, DK-25),
// as an integer number of hundredths. The prompts stay in English; only the currency they name
// and the way their examples write it change.

/** How the daemon writes amounts in each language, as `formatAmount` does. */
const AMOUNT_TAGS: Record<Locale, string> = { es: 'es-ES', en: 'en-GB' };

const currencyNames = new Intl.DisplayNames('en', { type: 'currency' });

/** B78: the hundredth of a currency whose English name is not `cents`: a pound has pence. */
const MINOR_UNITS: Readonly<Record<string, string>> = { GBP: 'pence' };

/** What a hundredth of the principal's currency is called in English: `cents`, or `pence`. */
export const minorUnit = (): string => MINOR_UNITS[getCurrency()] ?? 'cents';

/**
 * `euro cents` with EUR, the words every evaluation so far was measured with; otherwise the
 * currency's English name, its hundredth and its code, such as `US Dollar cents (USD)` or
 * `British Pound pence (GBP)`.
 */
export const centsName = (): string => {
  const currency = getCurrency();
  return currency === 'EUR'
    ? 'euro cents'
    : `${currencyNames.of(currency)} ${minorUnit()} (${currency})`;
};

/** `units` whole units of the principal's currency as the principal writes them: `23 €`, `US$23`. */
export const wholeAmount = (units: number): string =>
  new Intl.NumberFormat(AMOUNT_TAGS[getLocale()], {
    style: 'currency',
    currency: getCurrency(),
    maximumFractionDigits: 0,
  })
    .format(units)
    // Intl writes a no-break space before `€`; a person types a plain one.
    .replace(/\s/gu, ' ');
