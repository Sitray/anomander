// DK-15: how each account a subscription login is made with is named in the window: the same
// names as the `/login` buttons in Telegram (S-60). The accounts themselves are the shell's
// (`src-tauri/src/login.rs`), which mirrors `LOGIN_ACCOUNTS` of the daemon.
import { buttons } from '@anomander/protocol';

// Read when used, never on import: the buttons follow the window's language (`../locale.ts`).
export const ACCOUNT_LABELS = {
  get openai() {
    return buttons.chatGpt;
  },
  get 'kimi-coding'() {
    return buttons.kimiCode;
  },
  get anthropic() {
    return buttons.claude;
  },
  get 'github-copilot'() {
    return buttons.gitHubCopilot;
  },
} as const satisfies Record<string, string>;

/** The account's name, or its provider ID for one the window does not know. */
export const labelOf = (providerId: string): string =>
  (ACCOUNT_LABELS as Record<string, string>)[providerId] ?? providerId;
