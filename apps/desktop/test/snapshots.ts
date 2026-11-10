import type { DaemonStatus, SetupState, Snapshot } from '../src/shell.ts';

export const TOKEN = 'launch-token-0123456789abcdefghijklmnop';
export const CHANNEL = { url: 'ws://127.0.0.1:43210', token: TOKEN };

export const configured: SetupState = {
  hasTelegramBotToken: true,
  principalChatId: '4242',
  model: 'openai/gpt-4o-mini',
  visionModel: 'openai/gpt-4o-mini',
  providerKeys: ['OPENAI_API_KEY'],
};

export const running = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  daemon: { state: 'running', reason: null, lastError: null },
  channel: CHANNEL,
  setup: configured,
  ...overrides,
});

export const stopped = (daemon: Partial<DaemonStatus> = {}, setup = configured): Snapshot => ({
  daemon: { state: 'stopped', reason: null, lastError: null, ...daemon },
  channel: null,
  setup,
});

export const notConfigured = (): Snapshot =>
  stopped(
    { reason: 'not_configured' },
    {
      hasTelegramBotToken: false,
      principalChatId: null,
      model: null,
      visionModel: null,
      providerKeys: [],
    },
  );
