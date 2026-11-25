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

const LOCAL_TOKEN = 'local-channel-token-0123456789abcdef';
const API_TOKEN = 'read-api-token-0123456789abcdef-x';

describe('loadConfig', () => {
  it('reads Telegram and applies the §14.4 defaults', () => {
    // R-28 AC5: the models are not required to start.
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
      telegram: { botToken: '123:abc', principalChatId: 4242 },
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
      currency: 'EUR',
      locale: 'es',
      apiToken: undefined,
      apiHost: '127.0.0.1',
      apiPort: 4311,
      localToken: undefined,
      localPort: 4312,
      mcpConfigPath: undefined,
      mcpSecrets: undefined,
      authJson: undefined,
      mcpOAuth: undefined,
    });
  });

  // T13: Telegram is one front door, the desktop app's local channel the other; one is enough.
  it('refuses to start without a front door, naming both', () => {
    expect(() => loadConfig({})).toThrow(
      "missing configuration: no front door. Set TELEGRAM_BOT_TOKEN (the token @BotFather gives when you create the bot) and ANOMANDER_PRINCIPAL_CHAT_ID (your Telegram user ID, which @userinfobot tells you) for Telegram, or ANOMANDER_LOCAL_TOKEN for the desktop app's chat",
    );
  });

  it('starts with the local channel alone, without Telegram', () => {
    expect(loadConfig({ ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN })).toMatchObject({
      telegram: undefined,
      localToken: LOCAL_TOKEN,
    });
  });

  it('refuses half of Telegram, even beside the local channel', () => {
    expect(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: '123:abc', ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN }),
    ).toThrow(
      'missing configuration: ANOMANDER_PRINCIPAL_CHAT_ID (your Telegram user ID, which @userinfobot tells you)',
    );
    expect(() => loadConfig({ ANOMANDER_PRINCIPAL_CHAT_ID: '4242' })).toThrow(
      'missing configuration: TELEGRAM_BOT_TOKEN (the token @BotFather gives when you create the bot)',
    );
  });

  it('keeps Telegram beside the local channel', () => {
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: '123:abc',
        ANOMANDER_PRINCIPAL_CHAT_ID: '4242',
        ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN,
      }),
    ).toMatchObject({
      telegram: { botToken: '123:abc', principalChatId: 4242 },
      localToken: LOCAL_TOKEN,
    });
  });

  // RA-2 AC1, AC3 (docs/read-access-prd.md): the read API's token, address and port.
  it('reads the read API settings and rejects a host that is not an address or a bad port', () => {
    const required = { TELEGRAM_BOT_TOKEN: '123:abc', ANOMANDER_PRINCIPAL_CHAT_ID: '4242' };
    expect(
      loadConfig({
        ...required,
        ANOMANDER_API_TOKEN: API_TOKEN,
        ANOMANDER_API_HOST: '100.64.0.7',
        ANOMANDER_API_ALLOW_PLAIN_HTTP: '1',
        ANOMANDER_API_PORT: '8080',
      }),
    ).toMatchObject({ apiToken: API_TOKEN, apiHost: '100.64.0.7', apiPort: 8080 });
    expect(() =>
      loadConfig({ ...required, ANOMANDER_API_HOST: 'example.com', ANOMANDER_API_PORT: '70000' }),
    ).toThrow(
      'invalid configuration: ANOMANDER_API_HOST must be an IP address; ANOMANDER_API_PORT must be a port from 1 to 65535',
    );
  });

  // T14, security audit M4: a guessable token or plain HTTP off this machine.
  describe('the read API token and host (RA-2 AC2, AC3)', () => {
    const required = { TELEGRAM_BOT_TOKEN: '123:abc', ANOMANDER_PRINCIPAL_CHAT_ID: '4242' };

    it('keeps a token of 32 characters or more on this machine, as before', () => {
      expect(loadConfig({ ...required, ANOMANDER_API_TOKEN: API_TOKEN })).toMatchObject({
        apiToken: API_TOKEN,
        apiHost: '127.0.0.1',
        apiPort: 4311,
      });
      for (const host of ['127.0.0.2', '::1']) {
        expect(
          loadConfig({ ...required, ANOMANDER_API_TOKEN: API_TOKEN, ANOMANDER_API_HOST: host }),
        ).toMatchObject({ apiHost: host });
      }
    });

    it('refuses a token shorter than 32 characters', () => {
      expect(() =>
        loadConfig({ ...required, ANOMANDER_API_TOKEN: API_TOKEN.slice(0, 31) }),
      ).toThrow('invalid configuration: ANOMANDER_API_TOKEN must have at least 32 characters');
    });

    it('refuses a host off this machine unless plain HTTP is allowed on purpose', () => {
      for (const host of ['100.64.0.7', '0.0.0.0', '::']) {
        expect(() =>
          loadConfig({ ...required, ANOMANDER_API_TOKEN: API_TOKEN, ANOMANDER_API_HOST: host }),
        ).toThrow(
          `invalid configuration: ANOMANDER_API_HOST ${host} is not this machine and the read API has no TLS: set ANOMANDER_API_ALLOW_PLAIN_HTTP=1 to send the token over plain HTTP anyway`,
        );
      }
      expect(() =>
        loadConfig({
          ...required,
          ANOMANDER_API_TOKEN: API_TOKEN,
          ANOMANDER_API_HOST: '100.64.0.7',
          ANOMANDER_API_ALLOW_PLAIN_HTTP: 'yes',
        }),
      ).toThrow('invalid configuration: ANOMANDER_API_ALLOW_PLAIN_HTTP must be 1 when set');
    });

    it('does not check the host while the read API is off', () => {
      expect(loadConfig({ ...required, ANOMANDER_API_HOST: '100.64.0.7' })).toMatchObject({
        apiToken: undefined,
        apiHost: '100.64.0.7',
      });
    });
  });

  it('reads the secrets of the connections the app hands over (DK-11)', () => {
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: '123:abc',
        ANOMANDER_PRINCIPAL_CHAT_ID: '4242',
        ANOMANDER_MCP_SECRETS: '{"mcp/notes/env/T":"abc"}',
      }).mcpSecrets,
    ).toBe('{"mcp/notes/env/T":"abc"}');
  });

  it('reads the OAuth tokens the app hands over (DK-11)', () => {
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: '123:abc',
        ANOMANDER_PRINCIPAL_CHAT_ID: '4242',
        ANOMANDER_MCP_OAUTH: '{}',
      }).mcpOAuth,
    ).toBe('{}');
  });

  it('reads the model login the app hands over (DK-5 AC1)', () => {
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: '123:abc',
        ANOMANDER_PRINCIPAL_CHAT_ID: '4242',
        ANOMANDER_AUTH_JSON: '{}',
      }).authJson,
    ).toBe('{}');
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

  // S3: the language of the daemon's text; Spanish unless `ANOMANDER_LOCALE` says English.
  it('reads ANOMANDER_LOCALE, Spanish by default, and rejects any other language', () => {
    const telegram = { TELEGRAM_BOT_TOKEN: '123:abc', ANOMANDER_PRINCIPAL_CHAT_ID: '4242' };
    expect(loadConfig(telegram).locale).toBe('es');
    expect(loadConfig({ ...telegram, ANOMANDER_LOCALE: '' }).locale).toBe('es');
    expect(loadConfig({ ...telegram, ANOMANDER_LOCALE: 'es' }).locale).toBe('es');
    expect(loadConfig({ ...telegram, ANOMANDER_LOCALE: 'en' }).locale).toBe('en');
    expect(() => loadConfig({ ...telegram, ANOMANDER_LOCALE: 'fr' })).toThrow(
      /invalid configuration: ANOMANDER_LOCALE /,
    );
  });

  // DK-25 (B15): the principal's currency, euros unless `ANOMANDER_CURRENCY` names another.
  it('reads ANOMANDER_CURRENCY, euros by default, any case, and rejects what is not ISO 4217', () => {
    const telegram = { TELEGRAM_BOT_TOKEN: '123:abc', ANOMANDER_PRINCIPAL_CHAT_ID: '4242' };
    expect(loadConfig(telegram).currency).toBe('EUR');
    expect(loadConfig({ ...telegram, ANOMANDER_CURRENCY: '' }).currency).toBe('EUR');
    expect(loadConfig({ ...telegram, ANOMANDER_CURRENCY: 'usd' }).currency).toBe('USD');
    expect(() => loadConfig({ ...telegram, ANOMANDER_CURRENCY: 'XYZ' })).toThrow(
      'invalid configuration: ANOMANDER_CURRENCY must be an ISO 4217 currency, such as EUR',
    );
  });
});
