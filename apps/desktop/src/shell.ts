// The seam between the window (TypeScript) and the shell (Rust, `src-tauri`): every Tauri command
// and event the two exchange. The Rust side mirrors these names and shapes with serde
// (`rename_all = "camelCase"`); change both together.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** DK-6 AC1: what the menu bar icon shows. `starting` is a daemon launched and not yet listening. */
export type DaemonState = 'starting' | 'running' | 'stopped' | 'failing';

/**
 * Why the daemon is not running, when the shell knows:
 * - `not_configured`: the setup screen still lacks the bot token or the principal's chat ID;
 * - `already_running`: another daemon runs on the same database (DK-2 AC1, exit code 3);
 * - `bot_in_use`: another ANOMANDER uses the Telegram bot (DK-2 AC2, exit code 4);
 * - `gave_up`: it exited 3 times within 5 minutes (DK-1 AC2);
 * - `stopped_by_principal`: stopped from the menu bar or the window.
 */
export type StopReason =
  | 'not_configured'
  | 'already_running'
  | 'bot_in_use'
  | 'gave_up'
  | 'stopped_by_principal';

export interface DaemonStatus {
  state: DaemonState;
  reason: StopReason | null;
  /** The daemon's last error line, with every secret removed (DK-1 AC2); `null` when none. */
  lastError: string | null;
}

/** Where the chat connects (DK-3); `null` unless the daemon is `running`. */
export interface LocalChannel {
  /** `ws://127.0.0.1:<port>`. */
  url: string;
  /** This launch's token, presented as the second WebSocket subprotocol. */
  token: string;
}

/** What the setup screen shows. Secrets are never sent back: only whether each one is stored. */
export interface SetupState {
  hasTelegramBotToken: boolean;
  /** `ANOMANDER_PRINCIPAL_CHAT_ID`, as typed. */
  principalChatId: string | null;
  /** `ANOMANDER_MODEL`, such as `openai/gpt-4o-mini`. */
  model: string | null;
  /** `ANOMANDER_VISION_MODEL`. */
  visionModel: string | null;
  /** The provider variables whose key is stored, such as `OPENAI_API_KEY`. */
  providerKeys: string[];
}

export interface Snapshot {
  daemon: DaemonStatus;
  channel: LocalChannel | null;
  setup: SetupState;
}

/** What the setup screen saves (DK-5 AC1). Secrets go to the Keychain, the rest to a settings file. */
export interface SetupInput {
  /** Omitted keeps the stored token. */
  telegramBotToken?: string;
  principalChatId: string;
  model: string;
  visionModel: string;
  /** By provider variable, such as `OPENAI_API_KEY`: a string stores the key, `null` removes it. */
  providerKeys: Record<string, string | null>;
}

/** The event the shell emits with a new `Snapshot` whenever any part of it changes. */
export const SNAPSHOT_EVENT = 'shell://snapshot';

export const shell = {
  snapshot: (): Promise<Snapshot> => invoke('get_snapshot'),
  /** Saves the setup and starts the daemon again with it. */
  saveSetup: (setup: SetupInput): Promise<Snapshot> => invoke('save_setup', { setup }),
  startDaemon: (): Promise<void> => invoke('start_daemon'),
  stopDaemon: (): Promise<void> => invoke('stop_daemon'),
  /** Whether the chat waits for an answer, which the menu bar shows (DK-6). */
  setThinking: (thinking: boolean): Promise<void> => invoke('set_thinking', { thinking }),
  /**
   * A JPEG of the screen, taken now with the window out of the way. Rejects with
   * `screen_permission` when macOS does not let the app record the screen.
   */
  captureScreen: (): Promise<ArrayBuffer> => invoke('capture_screen'),
  /** An answer arrived: the shell notifies it unless the window is in front. */
  notifyReply: (text: string): Promise<void> => invoke('notify_reply', { text }),
  onSnapshot: (handler: (snapshot: Snapshot) => void): Promise<UnlistenFn> =>
    listen<Snapshot>(SNAPSHOT_EVENT, (event) => handler(event.payload)),
};
