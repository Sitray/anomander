import words from './careful-words.json' with { type: 'json' };

/**
 * DK-10 AC1: what a control of care is usually called, in Spanish and in English: sending,
 * paying, deleting, accepting, installing, signing out, passwords. One list for the daemon,
 * which reads the processor's `target`, and for the shell, which reads what the screen itself
 * says (`apps/desktop/src-tauri/src/computer/risk.rs` embeds the same file). `stems` match
 * anywhere in the text, `words` only as whole words; both compare without accents or case.
 */
export const CAREFUL_WORDS: {
  stems: readonly string[];
  words: readonly string[];
  /** Run by both readers' tests, so they cannot drift apart. */
  examples: { careful: readonly string[]; routine: readonly string[] };
} = words;

/**
 * `text` as both readers compare it: in lower case, decomposed with compatibility (NFKD, so a
 * fullwidth letter or a ligature reads as plain letters), without its marks (accents) and
 * without the characters that show as nothing (zero-width, word joiner, soft hyphen).
 */
export const foldCareful = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{M}\u200B-\u200D\u2060\uFEFF\u00AD]/gu, '');

/** Whether `text` names a control of care. */
export const isCarefulText = (text: string): boolean => {
  const plain = foldCareful(text);
  if (CAREFUL_WORDS.stems.some((stem) => plain.includes(stem))) return true;
  return plain.split(/[^a-z0-9_]+/).some((word) => CAREFUL_WORDS.words.includes(word));
};
