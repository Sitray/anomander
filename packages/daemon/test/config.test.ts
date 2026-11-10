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
    // R-28 AC5: the models are not required to start; the bot and chat say where to get them.
    expect(() => loadConfig({})).toThrow(
      'missing configuration: TELEGRAM_BOT_TOKEN (the token @BotFather gives when you create the bot), ANOMANDER_PRINCIPAL_CHAT_ID (your Telegram user ID, which @userinfobot tells you)',
    );
    expect(
      loadConfig({ TELEGRAM_BOT_TOKEN: '123:abc', ANOMANDER_PRINCIPAL_CHAT_ID: '4242' }),
    ).toMatchObject({
      model: undefined,
      visionModel: undefined,
    });

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
      processorTimeoutMs: 60_000,
      weeklySummaryCron: '0 20 * * 0',
      retentionCron: '0 3 * * *',
      inboxDir: './data/inbox',
      authPath: './data/auth.json',
      timeZone: 'Europe/Madrid',
      apiToken: undefined,
      apiHost: '127.0.0.1',
      apiPort: 4311,
      localToken: undefined,
      localPort: 4312,
      mcpConfigPath: undefined,
    });
  });

  // RA-2 AC1, AC3 (docs/read-access-prd.md): the read API's token, address and port.
  it('reads the read API settings and rejects a host that is not an address or a bad port', () => {
    const required = { TELEGRAM_BOT_TOKEN: '123:abc', ANOMANDER_PRINCIPAL_CHAT_ID: '4242' };
    expect(
      loadConfig({
        ...required,
        ANOMANDER_API_TOKEN: 's3cret',
        ANOMANDER_API_HOST: '100.64.0.7',
        ANOMANDER_API_PORT: '8080',
      }),
    ).toMatchObject({ apiToken: 's3cret', apiHost: '100.64.0.7', apiPort: 8080 });
    expect(() =>
      loadConfig({ ...required, ANOMANDER_API_HOST: 'example.com', ANOMANDER_API_PORT: '70000' }),
    ).toThrow(
      'invalid configuration: ANOMANDER_API_HOST must be an IP address; ANOMANDER_API_PORT must be a port from 1 to 65535',
    );
  });

  it('reads where the connections are configured (DK-11)', () => {
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: '123:abc',
        ANOMANDER_PRINCIPAL_CHAT_ID: '4242',
        ANOMANDER_MCP_CONFIG: '/data/mcp.json',
      }).mcpConfigPath,
    ).toBe('/data/mcp.json');
  });
});
