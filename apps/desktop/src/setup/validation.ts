// DK-5 AC1: the checks of the shell (`src-tauri/src/setup.rs`), made before saving so a mistake
// is explained in Spanish beside its field. The shell checks again; this only saves a round trip.

/** The providers offered by name; any other goes by the name of its variable. */
export const KNOWN_PROVIDER_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

/** A Telegram chat ID: an integer, negative for a group. Empty is "not set", as the shell takes it. */
export const isChatId = (value: string): boolean => value === '' || /^-?\d+$/.test(value);

/** `provider/model`, split at the first slash, neither side empty; or empty for "not set". */
export const isModelId = (value: string): boolean => value === '' || /^[^/]+\/.+$/.test(value);

export const isProviderKeyName = (value: string): boolean =>
  /^[A-Z][A-Z0-9_]*_API_KEY$/.test(value);
