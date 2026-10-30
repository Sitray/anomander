// R-2 AC5 and AC6: the amounts written literally in a message, in the forms `23`, `23,40`,
// `23.40`, `23€`, `23 €` and `€23`. The euro sign is not a digit, so it never changes what a
// number reads as. A number glued to more digits after its decimals (`23.405`) is not an amount.
const LITERAL_AMOUNT = /(?<!\d)(?<!\d[.,])(\d+)(?:[.,](\d{1,2}))?(?!\d|[.,]\d)/g;

/** Every amount written literally in `text`, normalized to integer cents, in reading order. */
export const literalAmountsInCents = (text: string): number[] => {
  const amounts: number[] = [];
  for (const match of text.matchAll(LITERAL_AMOUNT)) {
    const euros = Number(match[1]);
    const decimals = match[2] ?? '';
    const cents = euros * 100 + (decimals === '' ? 0 : Number(decimals.padEnd(2, '0')));
    if (Number.isSafeInteger(cents)) amounts.push(cents);
  }
  return amounts;
};

/** R-2 AC6: code accepts a processor's amount only if the principal wrote it. */
export const isLiteralAmount = (text: string, cents: number): boolean =>
  Number.isSafeInteger(cents) && literalAmountsInCents(text).includes(cents);
