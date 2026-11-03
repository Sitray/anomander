import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FakeTelegramApi,
  type SentMessage,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander, startSetupGuide } from '../../src/app.ts';
import { createFileCredentialStore } from '../../src/auth/file-credential-store.ts';
import { loadConfig } from '../../src/config.ts';
import { createConnectionGaps, resolveModels } from '../../src/setup/setup-guide.ts';

// End to end (PRD §15): `/start` and the setup guide (R-28, R-17 AC7) through the fake Telegram
// API and the real bot. The processor is a mock that must never be called while setup is
// incomplete.
const PRINCIPAL = 4242;
const principal = { chatId: PRINCIPAL };

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander | undefined;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };
const complete = vi.fn(async () => {
  throw new Error('the processor must not be called');
});

const configWith = (env: Record<string, string>) =>
  loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_AUTH_PATH: join(scratch, 'auth.json'),
    TZ: 'Europe/Madrid',
    ...env,
  });

const MODELS = { ANOMANDER_MODEL: 'openai/gpt-5.5', ANOMANDER_VISION_MODEL: 'openai/gpt-5.5' };

/** The full daemon, whose connection gaps come from the providers in `connected`. */
const startConnected = async (connected: Set<string>) => {
  const config = configWith(MODELS);
  anomander = startAnomander(config, {
    complete,
    model: 'openai/gpt-5.5',
    visionModel: 'openai/gpt-5.5',
    setupGaps: createConnectionGaps({
      providerIds: ['openai'],
      checkAuth: async (providerId) => (connected.has(providerId) ? { type: 'oauth' } : undefined),
      logger,
    }),
    telegramApiRoot: api.apiRoot,
    logger,
  });
  await anomander.started;
};

/** The setup guide, for the model gaps `env` leaves; every model ID but `openai/gpt-5.5` is unknown. */
const startGuide = async (env: Record<string, string>) => {
  const config = configWith(env);
  const resolved = resolveModels(config, (provider, id) =>
    `${provider}/${id}` === 'openai/gpt-5.5' ? 'known' : undefined,
  );
  if (resolved.ready) throw new Error('expected model gaps');
  anomander = startSetupGuide(config, {
    gaps: resolved.gaps,
    login: {
      models: {
        login: async () => {
          throw new Error('no login in this test');
        },
        logout: async () => {},
      },
      credentials: createFileCredentialStore(config.authPath),
      getDeviceId: () => '00000000-0000-4000-8000-000000000000',
    },
    telegramApiRoot: api.apiRoot,
    logger,
  });
  await anomander.started;
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-setup-'));
  api = await startFakeTelegramApi();
  logger = { info: vi.fn<Log>(), warn: vi.fn<Log>(), error: vi.fn<Log>() };
  complete.mockClear();
});

afterEach(async () => {
  await anomander?.stop();
  anomander = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Pushes an update and resolves with the message the bot sends next. */
const next = async (update: ReturnType<typeof updates.text>): Promise<SentMessage> => {
  const before = api.sent.length;
  api.push(update);
  const sent = await api.waitForSent(before + 1);
  return sent.at(-1) as SentMessage;
};

const warned = () => logger.warn.mock.calls.map(([message]) => message);

const UNSET_GUIDE =
  '¡Hola! Me falta:\n- El modelo y el modelo de visión (ANOMANDER_MODEL y ANOMANDER_VISION_MODEL en el .env).';
const UNCONNECTED_GUIDE =
  '¡Hola! Me falta:\n- Conectar tu cuenta de ChatGPT (/login o su API key en el .env).';

describe('/start and the setup guide (R-28)', () => {
  it('AC1: with setup complete, /start replies S-69 and never reaches the processor', async () => {
    await startConnected(new Set(['openai']));

    expect((await next(updates.text(principal, '/start'))).text).toBe('¡Hola!');
    expect(api.sent).toHaveLength(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('AC2-AC4: an unconnected provider gets the guide at start and on every message, until it is connected', async () => {
    const connected = new Set<string>();
    await startConnected(connected);

    expect((await api.waitForSent(1))[0]?.text).toBe(UNCONNECTED_GUIDE);
    expect(warned()).toEqual([
      'setup incomplete: provider openai has no login and no API key: use /login or set its key',
    ]);
    expect((await next(updates.text(principal, '/start'))).text).toBe(UNCONNECTED_GUIDE);
    expect((await next(updates.text(principal, 'hola, ¿qué tal?'))).text).toBe(UNCONNECTED_GUIDE);
    expect((await next(updates.photo(principal))).text).toBe(UNCONNECTED_GUIDE);
    expect(complete).not.toHaveBeenCalled();

    connected.add('openai');
    expect((await next(updates.text(principal, '/start'))).text).toBe('¡Hola!');
  });

  it('AC2, AC3: with no model set, the setup guide answers everything but /login and runs no processor', async () => {
    await startGuide({});

    expect((await api.waitForSent(1))[0]?.text).toBe(UNSET_GUIDE);
    expect(warned()).toEqual([
      'setup incomplete: ANOMANDER_MODEL and ANOMANDER_VISION_MODEL must both be set',
    ]);
    expect((await next(updates.text(principal, '/start'))).text).toBe(UNSET_GUIDE);
    expect((await next(updates.text(principal, '40 € en Mercadona'))).text).toBe(UNSET_GUIDE);
    expect((await next(updates.text(principal, '/login'))).text).toBe(
      '¿Con qué cuenta me conecto?',
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('AC2: a model pi-ai does not know is named with its variable', async () => {
    await startGuide({ ANOMANDER_MODEL: 'openai/gpt-5.5', ANOMANDER_VISION_MODEL: 'openai/nope' });

    expect((await api.waitForSent(1))[0]?.text).toBe(
      '¡Hola! Me falta:\n- Un modelo que exista en ANOMANDER_VISION_MODEL: openai/nope no lo encuentro.',
    );
  });
});
