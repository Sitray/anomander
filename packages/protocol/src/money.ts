// DK-25 (backlog B15): an expense is in one currency, its row's `currency` (ISO 4217), and its
// `total_cents` is always the amount times 100, whatever the currency. One currency per
// principal and no conversion: new expenses are written in the principal's currency, the rows
// already stored keep theirs, and a sum never adds two currencies.

/** An amount in one currency: `cents` is the amount times 100. */
export interface Money {
  cents: number;
  /** ISO 4217, upper case, such as `EUR`. */
  currency: string;
}

/**
 * What a figure of a text says: bare cents (in the principal's currency), one amount, or a sum
 * kept per currency, one entry per currency.
 */
export type Amount = number | Money | readonly Money[];

/** The currency every install had before it could be chosen, and still has unless one is set. */
export const DEFAULT_CURRENCY = 'EUR';

const KNOWN = new Set(Intl.supportedValuesOf('currency'));

/** `true` for an ISO 4217 code this runtime knows, upper case: `EUR`, `USD`, `MXN`. */
export const isCurrency = (code: string): boolean => /^[A-Z]{3}$/.test(code) && KNOWN.has(code);

let principal = DEFAULT_CURRENCY;

/** The principal's currency: the one new expenses are written in and bare cents are shown in. */
export const getCurrency = (): string => principal;

/** Chooses the principal's currency (`ANOMANDER_CURRENCY`) for the rest of the process. */
export const setCurrency = (currency: string): void => {
  if (!isCurrency(currency)) throw new Error(`not an ISO 4217 currency: ${currency}`);
  principal = currency;
};

/** The principal's currency first, then the others by code: the order a sum is said in. */
const byCurrency = (a: Money, b: Money): number =>
  Number(b.currency === principal) - Number(a.currency === principal) ||
  a.currency.localeCompare(b.currency);

/** Adds amounts currency by currency, never across currencies; nothing is an empty list. */
export const sumByCurrency = (amounts: readonly Money[]): Money[] => {
  const sums = new Map<string, number>();
  for (const { cents, currency } of amounts) sums.set(currency, (sums.get(currency) ?? 0) + cents);
  return [...sums].map(([currency, cents]) => ({ cents, currency })).sort(byCurrency);
};

/** `a` minus `b`, currency by currency, dropping the currencies left at zero. */
export const subtractByCurrency = (a: readonly Money[], b: readonly Money[]): Money[] =>
  sumByCurrency([...a, ...b.map(({ cents, currency }) => ({ cents: -cents, currency }))]).filter(
    ({ cents }) => cents !== 0,
  );

/**
 * Orders two sums from largest to smallest: by the amount in the first currency of `order`, then
 * the next one. With one currency, the larger amount comes first.
 */
export const compareSums = (
  a: readonly Money[],
  b: readonly Money[],
  order: readonly string[],
): number => {
  for (const currency of order) {
    const of = (sum: readonly Money[]) => sum.find((money) => money.currency === currency)?.cents;
    const difference = (of(b) ?? 0) - (of(a) ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** `true` when `amount` is nothing in every currency it holds. */
export const isZero = (amount: Amount): boolean =>
  typeof amount === 'number'
    ? amount === 0
    : 'cents' in amount
      ? amount.cents === 0
      : amount.every(({ cents }) => cents === 0);
