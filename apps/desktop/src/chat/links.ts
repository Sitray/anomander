// B25: the web addresses in a reply, so the window can open them in the browser. Only `http` and
// `https`: never `javascript:`, `file:` or any other scheme. The reply is otherwise plain text,
// never Markdown (DK-4 AC1).

/** A piece of a reply: plain text, or a web address to open. */
export type Piece = { text: string } | { url: string };

/** A candidate: a scheme, then anything up to a space or a quote mark around it. */
const CANDIDATE = /https?:\/\/[^\s<>"'«»“”‘’]+/gi;
/** What ends a sentence after an address is not part of it. */
const TRAILING = /[.,;:!?]+$/;

/** Whether `address` is a web address the browser may open. */
export const isWebAddress = (address: string): boolean => {
  try {
    const { protocol, hostname } = new URL(address);
    return (protocol === 'https:' || protocol === 'http:') && hostname !== '';
  } catch {
    return false;
  }
};

/** Drops what follows an address without being part of it: a full stop, a closing bracket. */
const trimmed = (candidate: string): string => {
  let address = candidate.replace(TRAILING, '');
  // A closing bracket belongs to the address only when it opened one.
  while (
    address.endsWith(')') &&
    (address.match(/\(/g) ?? []).length < (address.match(/\)/g) ?? []).length
  ) {
    address = address.slice(0, -1).replace(TRAILING, '');
  }
  return address;
};

/** `text` cut into its plain pieces and its web addresses, in order; joined, it is `text`. */
export const piecesOf = (text: string): Piece[] => {
  const pieces: Piece[] = [];
  let from = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const address = trimmed(match[0]);
    if (!isWebAddress(address)) continue;
    if (match.index > from) pieces.push({ text: text.slice(from, match.index) });
    pieces.push({ url: address });
    from = match.index + address.length;
  }
  if (from < text.length) pieces.push({ text: text.slice(from) });
  return pieces;
};
