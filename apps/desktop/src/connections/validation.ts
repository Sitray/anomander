// DK-11: the checks of the shell (`src-tauri/src/connections.rs`), which are the daemon's
// (`packages/daemon/src/connections/config.ts`), made before saving so a mistake is explained in
// Spanish beside its field. The shell checks again; this only saves a round trip.

/** A letter or a digit, then up to 39 of those, spaces, `.`, `_` and `-`. */
export const isServerName = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(value);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** HTTPS, or plain HTTP to this machine only. */
export const isServerUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
};

/** The lines of a text box, one item each: trimmed, the empty ones left out. */
export const lines = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** How a list of the file is shown in a text box. */
export const boxed = (items: readonly string[]): string => items.join('\n');

/**
 * What a text box holds. A box left as it was shown gives back the list of the file itself:
 * written by hand, an item may be empty, padded or of several lines, which `lines` would change.
 */
export const unboxed = (value: string, shown: readonly string[] | undefined): string[] =>
  shown !== undefined && value === boxed(shown) ? [...shown] : lines(value);
