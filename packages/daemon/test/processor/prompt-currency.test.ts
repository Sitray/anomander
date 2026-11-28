import { setCurrency, setLocale } from '@anomander/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { correctionInterpreterPrompt } from '../../src/processor/correction-interpreter.ts';
import { receiptReaderPrompt } from '../../src/processor/receipt-reader.ts';
import { textInterpreterPrompt } from '../../src/processor/text-interpreter.ts';

// B73: the processor reads amounts in the principal's currency (`ANOMANDER_CURRENCY`, DK-25),
// never in euros when another one is configured. With EUR the prompts say what they always said.
// B87: the correction interpreter corrects a stored expense, whose own currency it is given, so
// it never names the principal's.
afterEach(() => {
  setLocale('es');
  setCurrency('EUR');
});

/** The prompts that ask for new amounts, in the principal's currency. */
const PRINCIPAL_PROMPTS = {
  'text interpreter': textInterpreterPrompt,
  'receipt reader': receiptReaderPrompt,
};

const PROMPTS = { ...PRINCIPAL_PROMPTS, 'correction interpreter': correctionInterpreterPrompt };

/** B87: the correction interpreter's total, in the corrected expense's own currency. */
const CORRECTED_TOTAL =
  '"total": the new amount paid, in the currency of the expense\'s "total" (its "currency"), as an integer number of hundredths of that currency ("28,40" is 2840).';

describe('the currency the processor reads amounts in', () => {
  it('keeps euro cents and the euro examples with EUR', () => {
    expect(textInterpreterPrompt()).toContain(
      '"total": the amount paid, as an integer number of euro cents ("23,40" is 2340, "23 €" is 2300).',
    );
    expect(receiptReaderPrompt()).toContain(
      '"total": the total paid, as an integer number of euro cents ("23,40" is 2340). Exactly one.',
    );
    expect(correctionInterpreterPrompt()).toContain(CORRECTED_TOTAL);
    setLocale('en');
    expect(textInterpreterPrompt()).toContain(
      'an integer number of euro cents ("23.40" is 2340, "€23" is 2300).',
    );
  });

  it('says US dollar cents and dollar examples with USD', () => {
    setCurrency('USD');
    expect(textInterpreterPrompt()).toContain(
      '"total": the amount paid, as an integer number of US Dollar cents (USD) ("23,40" is 2340, "23 US$" is 2300).',
    );
    expect(receiptReaderPrompt()).toContain(
      '"total": the total paid, as an integer number of US Dollar cents (USD) ("23,40" is 2340). Exactly one.',
    );
    expect(correctionInterpreterPrompt()).toContain(CORRECTED_TOTAL);
    expect(correctionInterpreterPrompt()).not.toMatch(/US Dollar|USD/u);
    setLocale('en');
    expect(textInterpreterPrompt()).toContain(
      'an integer number of US Dollar cents (USD) ("23.40" is 2340, "US$23" is 2300).',
    );
  });

  it.each(Object.entries(PRINCIPAL_PROMPTS))('the %s says pence with GBP', (_name, prompt) => {
    setCurrency('GBP');
    expect(prompt()).toContain('British Pound pence (GBP)');
  });

  it.each(Object.entries(PROMPTS))('the %s never says euros with GBP', (_name, prompt) => {
    setCurrency('GBP');
    expect(prompt()).not.toMatch(/euro|€/iu);
  });

  // B78: a pound has pence, not cents; only the field name `amount_cents` keeps the word.
  it.each(Object.entries(PROMPTS))('the %s names pence, never cents, with GBP', (_name, prompt) => {
    setCurrency('GBP');
    expect(prompt()).not.toMatch(/(?<!amount_)cents/u);
  });

  it('keeps the receipt line in euro cents with EUR and says pence with GBP', () => {
    expect(receiptReaderPrompt()).toContain(
      '{"name":"<as printed>","quantity":<number>,"amount_cents":<integer cents of the whole line>}',
    );
    setCurrency('GBP');
    expect(receiptReaderPrompt()).toContain(
      '{"name":"<as printed>","quantity":<number>,"amount_cents":<integer pence of the whole line>}',
    );
  });
});
