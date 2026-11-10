import type { ChatReply } from '@anomander/protocol';
import type { DaemonStatus, LocalChannel, SetupState, Snapshot } from '../src/shell.ts';

// What the shell and the daemon would say, shared by the tests and the preview harness.
export const TOKEN = 'window-test-token-0123456789abcdefghij';
export const CHANNEL: LocalChannel = { url: 'ws://127.0.0.1:4312', token: TOKEN };

export const RUNNING: DaemonStatus = { state: 'running', reason: null, lastError: null };
export const STARTING: DaemonStatus = { state: 'starting', reason: null, lastError: null };

export const stopped = (
  reason: DaemonStatus['reason'],
  lastError: string | null = null,
): DaemonStatus => ({ state: 'stopped', reason, lastError });

export const EMPTY_SETUP: SetupState = {
  hasTelegramBotToken: false,
  principalChatId: null,
  model: null,
  visionModel: null,
  providerKeys: [],
};

export const FILLED_SETUP: SetupState = {
  hasTelegramBotToken: true,
  principalChatId: '4242',
  model: 'openai/gpt-4o-mini',
  visionModel: 'openai/gpt-4o-mini',
  providerKeys: ['OPENAI_API_KEY'],
};

export const runningSnapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  daemon: RUNNING,
  channel: CHANNEL,
  setup: FILLED_SETUP,
  ...overrides,
});

export const stoppedSnapshot = (
  reason: DaemonStatus['reason'],
  overrides: Partial<Snapshot> = {},
): Snapshot => ({
  daemon: stopped(reason),
  channel: null,
  setup: reason === 'not_configured' ? EMPTY_SETUP : FILLED_SETUP,
  ...overrides,
});

let replies = 0;

/** The daemon's `reply` to the request `inReplyTo`. */
export const replyTo = (inReplyTo: string, overrides: Partial<ChatReply> = {}): ChatReply => {
  replies += 1;
  return {
    type: 'reply',
    inReplyTo,
    channelRef: `desktop:reply-${replies}`,
    text: 'Apuntado: 23,00 € en restaurantes.',
    buttons: [],
    sentAt: '2026-11-10T10:00:00.000Z',
    ...overrides,
  };
};
