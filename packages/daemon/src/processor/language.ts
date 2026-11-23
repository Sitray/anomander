import { getLocale, type Locale } from '@anomander/protocol';

// The model answers the principal in the language the daemon chose at startup (`ANOMANDER_LOCALE`).
// The prompts stay in English; only the language they ask for changes.

const LANGUAGES: Record<Locale, { name: string; tag: string }> = {
  es: { name: 'Spanish', tag: 'es-ES' },
  en: { name: 'English', tag: 'en-GB' },
};

/** `Spanish (es-ES)` or `English (en-GB)`: the language every reply is written in. */
export const replyLanguage = (): string => {
  const { name, tag } = LANGUAGES[getLocale()];
  return `${name} (${tag})`;
};

/** `Spanish` or `English`: the language of the principal, as a prompt names it in passing. */
export const languageName = (): string => LANGUAGES[getLocale()].name;
