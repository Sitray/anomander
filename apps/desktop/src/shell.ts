// The seam between the window (TypeScript) and the shell (Rust, `src-tauri`): every Tauri command
// and event the two exchange. The Rust side mirrors these names and shapes with serde
// (`rename_all = "camelCase"`); change both together.
import type { ComputerAction } from '@anomander/protocol';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

/** DK-6 AC1: what the menu bar icon shows. `starting` is a daemon launched and not yet listening. */
export type DaemonState = 'starting' | 'running' | 'stopped' | 'failing';

/**
 * Why the daemon is not running, when the shell knows:
 * - `not_configured`: the setup screen still lacks a model, and Telegram (the bot token and the
 *   principal's chat ID) is not set up either: Telegram is optional (DK-5 AC4);
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
  /** DK-21: `ANOMANDER_DAILY_AI_CALL_LIMIT`, from 1 to 10000; omitted keeps the stored one. */
  dailyAiCallLimit?: number;
}

/** DK-11: a value of a server (a variable of its environment or a header): its name, never the value. */
export interface ConnectionValue {
  name: string;
  /** Whether a value is kept for it, in the Keychain or still in the file until the next start. */
  stored: boolean;
}

/** How a server of `mcp.json` is reached: a program of this machine, or a URL. */
export type ConnectionTarget =
  | { kind: 'process'; command: string; args: string[] }
  | { kind: 'http'; url: string };

/** One server of `mcp.json`, by the name the principal gave it. */
export type ConnectionServer = ConnectionTarget & {
  name: string;
  /** Its `env` when it is a program, its `headers` when it is a URL. */
  values: ConnectionValue[];
  /** The tools that run without asking. */
  readOnly: string[];
  /** OAuth tokens are kept for it at its address; never the tokens themselves. */
  oauth: boolean;
};

/** What the connections screen shows. */
export interface ConnectionsView {
  /** In the order of the file. */
  servers: ConnectionServer[];
  /**
   * Why nothing can be changed from the screen: where the file is not as the daemon reads it, in
   * the shell's own words. Then no server is listed.
   */
  invalid: string | null;
}

/** What the connections screen saves: one server, whole. */
export type ConnectionInput = ConnectionTarget & {
  /** The name it has in the file; omitted adds a server. */
  original?: string;
  name: string;
  /** A `value` goes to the Keychain; without one, what the server has under that name is kept. */
  values: { name: string; value?: string }[];
  readOnly: string[];
};

/**
 * DK-12: how an import of a ledger ended: `imported`, or why nothing changed. `not_a_path` is the
 * shell's: what was sent is not a full path.
 */
export type LedgerOutcome =
  | 'imported'
  | 'missing'
  | 'same_file'
  | 'not_a_ledger'
  | 'newer_ledger'
  | 'damaged'
  | 'daemon_running'
  | 'own_has_expenses'
  | 'not_a_path';

export interface LedgerImport {
  outcome: LedgerOutcome;
}

/** DK-11: how connecting a server with OAuth ended. */
export interface OAuthConnect {
  outcome: 'connected' | 'denied' | 'timed_out';
}

/** DK-15: one account a subscription login is made with (R-27 AC1), by pi-ai provider ID. */
export interface SubscriptionAccount {
  providerId: string;
  /** Whether a login is stored for it; never the login itself. */
  connected: boolean;
  /** Whether it is offered for login; otherwise it is listed only while connected (R-27 AC6). */
  login: boolean;
}

export interface SubscriptionsView {
  accounts: SubscriptionAccount[];
}

/**
 * DK-15: a step of a running login, as the shell tells the window: the browser was opened on the
 * login page, a device code to type on it, or the flow waits for the address the browser ended
 * on, pasted in the window. No address and no token travel here.
 */
export type LoginStep =
  | { kind: 'opened' }
  | { kind: 'device_code'; code: string }
  | { kind: 'prompt' };

/** DK-15: how a login ended. */
export interface LoginOutcome {
  outcome: 'connected' | 'timed_out' | 'cancelled';
}

/** The event the shell emits with a new `Snapshot` whenever any part of it changes. */
export const SNAPSHOT_EVENT = 'shell://snapshot';

/** DK-15: the event the shell emits with each `LoginStep` while a subscription login runs. */
export const LOGIN_EVENT = 'shell://login';

/** The event the shell emits when the menu bar's "Detener tarea" is chosen. */
export const STOP_TASK_EVENT = 'shell://stop-task';

/** B48: the event the shell emits each time it shows the chat window, hidden until then. */
export const CHAT_SHOWN_EVENT = 'shell://chat-shown';

/** DK-21: what the import of a ledger reads: a SQLite file, as `anomander.db` is. */
export const LEDGER_EXTENSIONS = ['db', 'sqlite', 'sqlite3'];

export const shell = {
  snapshot: (): Promise<Snapshot> => invoke('get_snapshot'),
  /** Saves the setup and starts the daemon again with it. */
  saveSetup: (setup: SetupInput): Promise<Snapshot> => invoke('save_setup', { setup }),
  /** DK-11: the servers of `mcp.json`. */
  connections: (): Promise<ConnectionsView> => invoke('get_connections'),
  /**
   * Adds or replaces one server and answers with the servers as they are now. The daemon starts
   * again to read the file, unless it is stopped. Rejects, with nothing changed, when the daemon
   * would not read the server or the file.
   */
  saveConnection: (server: ConnectionInput): Promise<ConnectionsView> =>
    invoke('save_connection', { server }),
  /** Takes one server out of the file; otherwise as `saveConnection`. */
  removeConnection: (name: string): Promise<ConnectionsView> =>
    invoke('remove_connection', { name }),
  /**
   * DK-12: imports the ledger at `path` (full, or from `~/`). The daemon is stopped meanwhile and
   * started again after if it ran. Rejects, with the app's ledger as it was, when the import fails.
   */
  importLedger: (path: string): Promise<LedgerImport> => invoke('import_ledger', { path }),
  /**
   * DK-21: the system's dialog for the data file of a Docker install; the path chosen, or `null`
   * when the principal chose none. Only SQLite files are offered: `anomander.db` is one.
   */
  pickLedgerFile: async (): Promise<string | null> => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'SQLite', extensions: LEDGER_EXTENSIONS }],
    });
    return typeof picked === 'string' ? picked : null;
  },
  /**
   * DK-11: connects the HTTP server `name` with OAuth: the shell opens the browser and waits, up
   * to 5 minutes, for the principal to authorize the app. Then the daemon starts again with the
   * tokens, unless it is stopped. Rejects, with nothing stored, when the connection fails.
   */
  connectOAuth: (name: string): Promise<OAuthConnect> => invoke('connect_oauth', { name }),
  /** DK-11: forgets the OAuth tokens of `name` and answers with the servers as they are now. */
  forgetOAuth: (name: string): Promise<ConnectionsView> => invoke('forget_oauth', { name }),
  /** DK-15: the accounts a subscription login is made with, and which are connected. */
  subscriptions: (): Promise<SubscriptionsView> => invoke('get_subscriptions'),
  /**
   * DK-15: logs in to `providerId` with the principal's subscription: the shell opens the
   * browser and waits, up to 10 minutes, telling each step on `onLoginStep`. Then the daemon
   * starts again with the login, unless it is stopped. Rejects, with nothing stored, when the
   * login fails or another one is running.
   */
  connectSubscription: (providerId: string): Promise<LoginOutcome> =>
    invoke('connect_subscription', { providerId }),
  /** DK-15: the address the browser ended on, for the login that waits for it (`prompt`). */
  answerLogin: (text: string): Promise<void> => invoke('answer_login', { text }),
  /** DK-15: forgets the login of `providerId` and answers with the accounts as they are now. */
  disconnectSubscription: (providerId: string): Promise<SubscriptionsView> =>
    invoke('disconnect_subscription', { providerId }),
  /** DK-15: each step of the login that runs. */
  onLoginStep: (handler: (step: LoginStep) => void): Promise<UnlistenFn> =>
    listen<LoginStep>(LOGIN_EVENT, (event) => handler(event.payload)),
  startDaemon: (): Promise<void> => invoke('start_daemon'),
  stopDaemon: (): Promise<void> => invoke('stop_daemon'),
  /** Whether the chat waits for an answer, which the menu bar shows (DK-6). */
  setThinking: (thinking: boolean): Promise<void> => invoke('set_thinking', { thinking }),
  /**
   * A JPEG of the screen, taken now with the app out of the way. With `keepHidden` the app stays
   * away after a capture that worked, until `reveal`. Rejects with `screen_permission` when macOS
   * does not let the app record the screen.
   */
  captureScreen: (keepHidden = false): Promise<ArrayBuffer> =>
    invoke('capture_screen', { keepHidden }),
  /**
   * DK-10: performs one action of a task, with the app out of the way, and answers with a JPEG of
   * the screen as it left it. With `keepHidden` the app stays away after an action that worked,
   * until `reveal`. `permitted` says the principal allowed it; without it the shell performs it
   * only when the screen shows a routine step (T1b). Rejects, and then nothing was done, with
   * `computer_permission` or `screen_permission` when macOS does not allow it,
   * `computer_careful[:<role>:<name>]` when the screen shows a step of care nobody allowed, or
   * `computer_blocked:<app>` when it targets an app ANOMANDER never acts on.
   */
  performAction: (
    action: ComputerAction,
    keepHidden = false,
    permitted = false,
  ): Promise<ArrayBuffer> => invoke('perform_action', { action, keepHidden, permitted }),
  /** Brings the app and the chat back to the front. */
  reveal: (): Promise<void> => invoke('reveal'),
  /** Whether a task goes by itself, so the menu bar offers "Detener tarea" (DK-10). */
  setTaskRunning: (running: boolean): Promise<void> => invoke('set_task_running', { running }),
  /** The principal chose "Detener tarea" in the menu bar. */
  onStopTask: (handler: () => void): Promise<UnlistenFn> => listen(STOP_TASK_EVENT, handler),
  /** B48: calls `handler` each time the shell shows the chat window. */
  onChatShown: (handler: () => void): Promise<UnlistenFn> => listen(CHAT_SHOWN_EVENT, handler),
  /** An answer arrived: the shell notifies it unless the window is in front. */
  notifyReply: (text: string): Promise<void> => invoke('notify_reply', { text }),
  onSnapshot: (handler: (snapshot: Snapshot) => void): Promise<UnlistenFn> =>
    listen<Snapshot>(SNAPSHOT_EVENT, (event) => handler(event.payload)),
};
