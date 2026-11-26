import type { TelegramLoginDeps } from '../auth/telegram-login.ts';
import type { Connection } from '../connections/connection.ts';
import type { OAuthSet } from '../connections/oauth.ts';
import type { ConnectionProblems } from '../connections/task.ts';
import type { LocalChannelAddress } from '../local-channel/server.ts';
import type { Complete, Logger } from '../processor/ports.ts';
import type { ReadApiAddress } from '../read-api/server.ts';
import type { SetupGap } from '../setup/setup-guide.ts';

export interface AnomanderDeps<M> {
  /** The processor call: pi-ai's `models.complete` (R-14 AC3). It must honour `signal`. */
  complete: Complete<M>;
  /** `ANOMANDER_MODEL`, resolved by the caller (R-15 AC1). */
  model: M;
  /**
   * `ANOMANDER_VISION_MODEL`, resolved by the caller (R-15 AC1), for reading receipts. Without
   * it, receipts are read with `model`.
   */
  visionModel?: M;
  /**
   * Model login from Telegram (R-27): pi-ai's `models`, the credential store it uses and the
   * device ID. `main.ts` always passes it; tests that leave it out, and a daemon without
   * Telegram, get no `/login` or `/logout`.
   */
  login?: LoginDeps;
  /**
   * The connection gaps, checked on every message (R-28 AC4) before its turn, through
   * `cachedSetupGaps`. `main.ts` passes pi-ai's `checkAuth` for both models' providers; without
   * it, setup is always complete.
   */
  setupGaps?: () => Promise<readonly SetupGap[]>;
  /** How long `stop` waits for the turns that run before it closes the store; 5 s by default. */
  shutdownDeadlineMs?: number;
  /** Points the bot at another Bot API server, such as the fake one in tests. */
  telegramApiRoot?: string;
  /**
   * The servers connected now (DK-11). Without it they are the ones of `ANOMANDER_MCP_CONFIG`,
   * connected when a task first needs them; tests pass their own.
   */
  connections?: () => Promise<readonly Connection[]>;
  /** What is known about the servers that are not connected; goes with `connections`. */
  connectionProblems?: () => ConnectionProblems;
  /** Hands the OAuth tokens a refresh changed to the shell; tests catch them. */
  printOAuth?: (entries: OAuthSet) => void;
  logger?: Logger;
  now?: () => Date;
}

export type LoginDeps = Pick<
  TelegramLoginDeps,
  'models' | 'credentials' | 'getDeviceId' | 'timeoutMs'
>;

export interface Anomander {
  /** Resolves when the store is ready and the bot, if there is one, polls for messages. */
  started: Promise<void>;
  /**
   * Settles when polling ends: resolves after `stop`, rejects when Telegram ends it, for example
   * with the 409 of another process reading the same bot (DK-2 AC2). The daemon is deaf to
   * Telegram from then on, so the caller should stop it. Without Telegram it resolves at `stop`.
   */
  polling: Promise<void>;
  /**
   * Resolves with the read API's address once it listens (RA-2); `undefined` while
   * `ANOMANDER_API_TOKEN` is unset, when no port is opened at all (AC1).
   */
  readApi: Promise<ReadApiAddress> | undefined;
  /**
   * Resolves with the local channel's address once it listens (DK-3); `undefined` while
   * `ANOMANDER_LOCAL_TOKEN` is unset, when no port is opened at all.
   */
  localChannel: Promise<LocalChannelAddress> | undefined;
  /**
   * B51: from now on nothing new starts (no turn, no job, no input of a door) and the doors
   * begin to close, without waiting for anything: for a crash that waits for its log line.
   */
  halt(): void;
  stop(): Promise<void>;
}
