import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChatEvent,
  type ChatProbe,
  LOCAL_CHANNEL_PROTOCOL,
  type ProbeOutcome,
} from '@anomander/protocol';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { SETUP_PROVIDERS } from '../../../../apps/desktop/src/setup/providers.ts';
import {
  type Anomander,
  type AnomanderDeps,
  startAnomander,
  startSetupGuide,
} from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import type { SetupGap } from '../../src/setup/setup-guide.ts';

// DK-23 (docs/desktop-prd.md): what the desktop app's onboarding asks of the daemon, through a
// real WebSocket client on the local channel, as the window is: the setup guide in the app's own
// words (AC5) and "Probar", one minimal call to the saved model (AC4).
const TOKEN = 'onboarding-test-token-0123456789abcdefgh';
const MODEL = 'google/gemini-2.5-flash';
/** A key as a provider may quote it back in its error. */
const KEY = 'AIza-secret-key-0123456789';

let scratch: string;
let anomander: Anomander | undefined;
let sockets: WebSocket[];
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };

const answer = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  api: 'google-generative-ai',
  provider: 'google',
  model: 'gemini-2.5-flash',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 0,
  ...overrides,
});

const config = (env: Record<string, string> = {}) => ({
  ...loadConfig({
    ANOMANDER_LOCAL_TOKEN: TOKEN,
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_MODEL: MODEL,
    ANOMANDER_VISION_MODEL: MODEL,
    ...env,
  }),
  localPort: 0,
});

const start = async (
  deps: Partial<AnomanderDeps<string>> = {},
  env: Record<string, string> = {},
): Promise<Anomander> => {
  anomander = startAnomander(config(env), {
    complete: async () => answer({}),
    model: MODEL,
    logger,
    ...deps,
  });
  await anomander.started;
  return anomander;
};

const guide = async (
  gaps: readonly SetupGap[],
  models: { model?: undefined; visionModel?: undefined } = {},
): Promise<Anomander> => {
  anomander = startSetupGuide({ ...config(), ...models }, { gaps, logger });
  await anomander.started;
  return anomander;
};

/** A connected client: `ask` sends a request and resolves with the event that answers it. */
const client = async (daemon: Anomander) => {
  const address = await daemon.localChannel;
  if (address === undefined) throw new Error('the local channel did not start');
  const socket = new WebSocket(`ws://${address.host}:${address.port}`, [
    LOCAL_CHANNEL_PROTOCOL,
    TOKEN,
  ]);
  sockets.push(socket);
  const events: (ChatEvent | ChatProbe)[] = [];
  socket.addEventListener('message', (message) => events.push(JSON.parse(String(message.data))));
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  let next = 1;
  return {
    events,
    ask: async (request: Record<string, unknown>): Promise<ChatEvent | ChatProbe> => {
      const id = `m${next++}`;
      socket.send(JSON.stringify({ ...request, id }));
      await vi.waitFor(() => expect(events.some((event) => event.inReplyTo === id)).toBe(true), {
        timeout: 5_000,
      });
      return events.find((event) => event.inReplyTo === id) as ChatEvent | ChatProbe;
    },
  };
};

const probe = async (daemon: Anomander): Promise<ProbeOutcome> => {
  const event = await (await client(daemon)).ask({ type: 'probe_model' });
  if (event.type !== 'probe') throw new Error(`expected a probe, got ${JSON.stringify(event)}`);
  return event.outcome;
};

const textOf = (event: ChatEvent | ChatProbe): string => {
  if (event.type !== 'reply') throw new Error(`expected a reply, got ${JSON.stringify(event)}`);
  return event.text;
};

const callsToday = (): number => {
  const db = new Database(join(scratch, 'anomander.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT SUM(calls) AS calls FROM ai_usage').get() as { calls: number };
    return row.calls ?? 0;
  } finally {
    db.close();
  }
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-onboarding-'));
  sockets = [];
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(async () => {
  for (const socket of sockets) socket.close();
  await anomander?.stop();
  anomander = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

describe('the setup guide in the app (DK-23 AC5)', () => {
  it('names the window, never .env or /login, and says an unknown model once', async () => {
    const daemon = await guide([
      { kind: 'model_unknown', variable: 'ANOMANDER_MODEL', model: 'google/nope' },
      { kind: 'model_unknown', variable: 'ANOMANDER_VISION_MODEL', model: 'google/nope' },
    ]);
    const text = textOf(await (await client(daemon)).ask({ type: 'text', text: 'hola' }));

    expect(text).toBe(
      '¡Hola! Me falta:\n- Un modelo que exista: google/nope no lo encuentro. Elige otro en Configuración.',
    );
  });

  it('asks for the model in the window when none is set (S-171)', async () => {
    const daemon = await guide([{ kind: 'model_unset' }]);
    const text = textOf(await (await client(daemon)).ask({ type: 'text', text: 'hola' }));

    expect(text).toBe(
      '¡Hola! Me falta:\n- Elegir el modelo: abre Configuración, en la barra de arriba.',
    );
  });

  it('sends a provider without a key or a login to Configuración or Suscripciones (S-173)', async () => {
    const daemon = await start({
      setupGaps: async () => [{ kind: 'provider_unconnected', providerId: 'openai' }],
    });
    const text = textOf(await (await client(daemon)).ask({ type: 'text', text: 'hola' }));

    expect(text).toBe(
      '¡Hola! Me falta:\n- Conectar tu cuenta de ChatGPT: pon su clave en Configuración o conéctala en Suscripciones.',
    );
    expect(text).not.toMatch(/\.env|\/login|ANOMANDER_/);
  });
});

describe('"Probar" (DK-23 AC4)', () => {
  it('makes one call to the saved model and counts it against the daily budget (R-12)', async () => {
    const complete = vi.fn(async (_model: string) => answer({}));
    const daemon = await start({ complete });

    expect(await probe(daemon)).toBe('ok');
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toBe(MODEL);
    expect(callsToday()).toBe(1);
  });

  it('never echoes the key the provider quoted, to the window or to the log', async () => {
    const daemon = await start({
      complete: async () =>
        answer({
          stopReason: 'error',
          errorMessage: `401 {"error":{"message":"API key not valid: ${KEY}"}}`,
        }),
    });
    const chat = await client(daemon);
    await chat.ask({ type: 'probe_model' });

    expect(chat.events).toEqual([{ type: 'probe', inReplyTo: 'm1', outcome: 'key_refused' }]);
    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('API key not valid');
  });

  it.each<[string, ProbeOutcome]>([
    ['403 Forbidden: invalid x-api-key', 'key_refused'],
    ['404 models/gemini-x is not found for API version v1beta', 'model_unavailable'],
    ['429 RESOURCE_EXHAUSTED: quota exceeded', 'provider_limit'],
    ['500 Internal error', 'failed'],
  ])('tells the provider error %j in plain words: %s', async (errorMessage, outcome) => {
    const daemon = await start({
      complete: async () => answer({ stopReason: 'error', errorMessage }),
    });
    expect(await probe(daemon)).toBe(outcome);
  });

  it('says a call that fails without an answer failed', async () => {
    const daemon = await start({
      complete: async () => {
        throw new Error(`fetch failed for ${KEY}`);
      },
    });
    expect(await probe(daemon)).toBe('failed');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(KEY);
  });

  it('gives up on a provider that does not answer in time', async () => {
    const daemon = await start(
      { complete: () => new Promise<AssistantMessage>(() => {}) },
      { ANOMANDER_PROCESSOR_TIMEOUT_SECONDS: '1' },
    );
    expect(await probe(daemon)).toBe('timed_out');
  });

  it('makes no call once the budget is spent', async () => {
    const complete = vi.fn(async () => answer({}));
    const daemon = await start({ complete }, { ANOMANDER_DAILY_AI_CALL_LIMIT: '1' });

    expect(await probe(daemon)).toBe('ok');
    expect(await probe(daemon)).toBe('budget_exhausted');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('makes no call while the provider has neither a key nor a login', async () => {
    const complete = vi.fn(async () => answer({}));
    const daemon = await start({
      complete,
      setupGaps: async () => [{ kind: 'provider_unconnected', providerId: 'google' }],
    });

    expect(await probe(daemon)).toBe('not_connected');
    expect(complete).not.toHaveBeenCalled();
    expect(callsToday()).toBe(0);
  });

  it('says why while the setup names no usable model', async () => {
    expect(
      await probe(
        await guide([{ kind: 'model_unset' }], { model: undefined, visionModel: undefined }),
      ),
    ).toBe('model_unset');
    await anomander?.stop();
    expect(
      await probe(
        await guide([{ kind: 'model_unknown', variable: 'ANOMANDER_MODEL', model: 'google/x' }]),
      ),
    ).toBe('model_unknown');
  });

  it('says the photo model is missing when only that one is unset', async () => {
    const daemon = await guide([{ kind: 'model_unset' }], { visionModel: undefined });
    expect(await probe(daemon)).toBe('vision_model_unset');
  });
});

describe('the providers the setup screen offers (DK-23 AC2)', () => {
  const models = builtinModels({});

  it.each(SETUP_PROVIDERS.map((provider) => [provider.id, provider.suggested] as const))(
    '%s suggests %s, a model pi-ai knows that reads photos',
    (providerId, suggested) => {
      const model = models.getModel(providerId, suggested);
      expect(model).toBeDefined();
      expect(model?.input).toContain('image');
    },
  );
});
