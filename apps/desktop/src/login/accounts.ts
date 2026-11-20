// DK-15: how each account a subscription login is made with is named in the window: the same
// names as the `/login` buttons in Telegram (S-60). The accounts themselves are the shell's
// (`src-tauri/src/login.rs`), which mirrors `LOGIN_ACCOUNTS` of the daemon.
import { buttons } from '@anomander/protocol';

export const ACCOUNT_LABELS = {
  openai: buttons.chatGpt,
  'kimi-coding': buttons.kimiCode,
  anthropic: buttons.claude,
  'github-copilot': buttons.gitHubCopilot,
} as const satisfies Record<string, string>;

/** The account's name, or its provider ID for one the window does not know. */
export const labelOf = (providerId: string): string =>
  (ACCOUNT_LABELS as Record<string, string>)[providerId] ?? providerId;
