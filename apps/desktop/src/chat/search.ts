// DK-21: finding words in the conversation the window has loaded, ignoring case and accents.

/** One character as the search compares it: lower case, without its accents. */
const fold = (char: string): string => char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Where `query` is in `text`: `[start, end)` ranges of `text`; none for a blank query. */
export const matchesIn = (text: string, query: string): Array<[number, number]> => {
  const wanted = [...query.trim()].map(fold).join('');
  if (wanted === '') return [];
  let folded = '';
  /** For each unit of `folded`, where its character starts in `text`; then `text.length`. */
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    const piece = fold(char);
    for (let unit = 0; unit < piece.length; unit += 1) origin.push(index);
    folded += piece;
    index += char.length;
  }
  origin.push(text.length);
  const found: Array<[number, number]> = [];
  for (
    let at = folded.indexOf(wanted);
    at !== -1;
    at = folded.indexOf(wanted, at + wanted.length)
  ) {
    found.push([origin[at] ?? text.length, origin[at + wanted.length] ?? text.length]);
  }
  return found;
};
