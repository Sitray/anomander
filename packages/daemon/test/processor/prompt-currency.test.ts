import { setCurrency, setLocale } from '@anomander/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { correctionInterpreterPrompt } from '../../src/processor/correction-interpreter.ts';
import { receiptReaderPrompt } from '../../src/processor/receipt-reader.ts';
import { textInterpreterPrompt } from '../../src/processor/text-interpreter.ts';

// B73: the processor reads amounts in the principal's currency (`ANOMANDER_CURRENCY`, DK-25),
// never in euros when another one is configured. With EUR the prompts say what they always said.
afterEach(() => {
  setLocale('es');
  setCurrency('EUR');
});

const PROMPTS = {
  'text interpreter': textInterpreterPrompt,
  'receipt reader': receiptReaderPrompt,
  'correction interpreter': correctionInterpreterPrompt,
};

describe('the currency the processor reads amounts in', () => {
  it('keeps euro cents and the euro examples with EUR', () => {
    expect(textInterpreterPrompt()).toContain(
      '"total": the amount paid, as an integer number of euro cents ("23,40" is 2340, "23 €" is 2300).',
    );
    expect(receiptReaderPrompt()).toContain(
      '"total": the total paid, as an integer number of euro cents ("23,40" is 2340). Exactly one.',
    );
    expect(correctionInterpreterPrompt()).toContain(
      '"total": the new amount paid, as an integer number of euro cents ("28,40" is 2840).',
    );
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
    expect(correctionInterpreterPrompt()).toContain(
      '"total": the new amount paid, as an integer number of US Dollar cents (USD) ("28,40" is 2840).',
    );
    setLocale('en');
    expect(textInterpreterPrompt()).toContain(
      'an integer number of US Dollar cents (USD) ("23.40" is 2340, "US$23" is 2300).',
    );
  });

  it.each(Object.entries(PROMPTS))('the %s never says euros with GBP', (_name, prompt) => {
    setCurrency('GBP');
    expect(prompt()).toContain('British Pound cents (GBP)');
    expect(prompt()).not.toMatch(/euro|€/iu);
  });
});
