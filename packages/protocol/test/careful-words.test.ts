import { describe, expect, it } from 'vitest';
import { CAREFUL_WORDS, isCarefulText } from '../src/careful-words.ts';

// DK-10 AC1: the words that make a control one of care live in `careful-words.json`, read by the
// daemon (the processor's `target`) and by the shell (what the screen itself says). Both run its
// examples, so the two readings cannot drift apart.
describe('the careful words (DK-10 AC1)', () => {
  it('takes every careful example for a control of care', () => {
    for (const text of CAREFUL_WORDS.examples.careful) {
      expect(isCarefulText(text), text).toBe(true);
    }
  });

  it('takes every routine example for a routine control', () => {
    for (const text of CAREFUL_WORDS.examples.routine) {
      expect(isCarefulText(text), text).toBe(false);
    }
  });

  it('compares without accents or case, and the short words only as whole words', () => {
    expect(isCarefulText('CONTRASEÑA')).toBe(true);
    expect(isCarefulText('sí')).toBe(true);
    expect(isCarefulText('ok.')).toBe(true);
    expect(isCarefulText('Bookmarks')).toBe(false);
    expect(isCarefulText('Design')).toBe(false);
  });
});
