import { describe, expect, it } from 'vitest';
import { loadConfig, parseModelId } from '../src/config.ts';

// PRD §14.4 and R-15 AC1.
describe('parseModelId', () => {
  it.each([
    ['openai/gpt-4o-mini', { provider: 'openai', id: 'gpt-4o-mini' }],
    ['openrouter/anthropic/x', { provider: 'openrouter', id: 'anthropic/x' }],
  ])('splits %j at the first slash', (value, expected) => {
    expect(parseModelId(value)).toEqual(expected);
  });
});

describe('loadConfig', () => {
  it('names every missing required variable and applies the §14.4 defaults', () => {
    expect(() => loadConfig({})).toThrow(
      'missing configuration: TELEGRAM_BOT_TOKEN, ANOMANDER_PRINCIPAL_CHAT_ID, ANOMANDER_MODEL, ANOMANDER_VISION_MODEL',
    );

    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: '123:abc',
        ANOMANDER_PRINCIPAL_CHAT_ID: '4242',
        ANOMANDER_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_VISION_MODEL: 'ollama/llava',
        ANOMANDER_DB_PATH: '',
      }),
    ).toEqual({
      telegramBotToken: '123:abc',
      principalChatId: 4242,
      dbPath: './data/anomander.db',
      model: { provider: 'openai', id: 'gpt-4o-mini' },
      visionModel: { provider: 'ollama', id: 'llava' },
      dailyAiCallLimit: 200,
      weeklySummaryCron: '0 20 * * 0',
      retentionCron: '0 3 * * *',
      inboxDir: './data/inbox',
      timeZone: 'Europe/Madrid',
    });
  });
});
