// What the principal wrote counts as a declaration only if the words are really there
// (R-2 AC3, R-3 AC5); the processor only points at them.

/** A non-empty, trimmed string, or `null`. */
export const textValue = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name appears in the text as a whole word, ignoring case. */
export const writtenIn = (text: string, name: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
