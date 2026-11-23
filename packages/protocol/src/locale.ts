// The language every text for the principal is written in. One process speaks one language for
// its whole life: the daemon from `ANOMANDER_LOCALE`, the window from the system's language as
// the shell reads it. Until a process chooses, the text is Spanish, as it always was.

export type Locale = 'es' | 'en';

export const LOCALES: readonly Locale[] = ['es', 'en'];

let active: Locale = 'es';

export const getLocale = (): Locale => active;

/** Chooses the language of every text read from now on. */
export const setLocale = (locale: Locale): void => {
  active = locale;
};

/**
 * The language for a system language tag: Spanish for any Spanish one (`es`, `es-ES`, `es-419`,
 * `es_ES.UTF-8`, `es@euro`), English for every other one, and for none.
 */
export const localeOf = (tag: string | null | undefined): Locale =>
  /^es(?:[-_.@]|$)/i.test(tag?.trim() ?? '') ? 'es' : 'en';

/**
 * One table of text per language, read as one: each property is looked up in the table of the
 * language chosen at the moment it is read. A section kept in a variable stays in the language
 * it was read in, so read through the view when the language may not be chosen yet.
 */
export const perLocale = <T extends object>(tables: Record<Locale, T>): T =>
  new Proxy(tables.es, {
    get: (_spanish, key) => Reflect.get(tables[active], key),
  });
