// The language of this window, chosen once, before any text is read: the first import of every
// page's entry module (`main.tsx`, `notch/main.ts`), since ES modules run their imports in order.
// The shell reads the system's preferred language and hands every webview the same answer
// (`src-tauri`); a page with no shell (a browser, the demo) follows the browser's language.
import { type Locale, localeOf, setLocale } from '@anomander/protocol';

declare global {
  interface Window {
    /** Set by the shell before any script of the page runs. */
    __ANOMANDER_LOCALE__?: Locale;
  }
}

/** Chooses the language of the protocol's text and of this window's, and says it to the page. */
export const chooseLocale = (): Locale => {
  const locale = localeOf(window.__ANOMANDER_LOCALE__ ?? navigator.language);
  setLocale(locale);
  document.documentElement.lang = locale;
  return locale;
};

chooseLocale();
