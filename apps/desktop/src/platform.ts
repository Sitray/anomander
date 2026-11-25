// The operating system this window runs on (DK-20): the shell says it before any script of the
// page runs (`src-tauri/src/platform.rs`), as it says the language. A page with no shell (a
// browser, the demo) is taken for macOS, the app's first platform.

export type Platform = 'macos' | 'windows';

declare global {
  interface Window {
    /** Set by the shell before any script of the page runs. */
    __ANOMANDER_PLATFORM__?: Platform;
  }
}

/** The platform, read each time: the text that depends on it follows it. */
export const platform = (): Platform =>
  typeof window !== 'undefined' && window.__ANOMANDER_PLATFORM__ === 'windows'
    ? 'windows'
    : 'macos';
