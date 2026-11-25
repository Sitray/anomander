// DK-20 (B27): the window's own shortcut, as in any app: Cmd+, on macOS, Ctrl+, on Windows,
// opens the setup and closes it again. The hotkey that brings the chat from any app is the
// shell's (`src-tauri/src/hotkey.rs`).
import { useEffect, useRef } from 'react';
import { platform } from './platform.ts';

/** Cmd on macOS, Ctrl on Windows, and no other modifier. */
const withCommand = (event: KeyboardEvent): boolean =>
  (platform() === 'windows' ? event.ctrlKey && !event.metaKey : event.metaKey && !event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey;

/** Calls `toggle` on Cmd+, (Ctrl+, on Windows), wherever the focus is in the window. */
export const useSetupShortcut = (toggle: () => void): void => {
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A held key repeats: only the first press counts, or the setup flips open and closed.
      if (event.key !== ',' || event.repeat || !withCommand(event)) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
};
