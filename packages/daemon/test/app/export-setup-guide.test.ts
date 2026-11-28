import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Anomander, startAnomander, startSetupGuide } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { createConnectionGaps, resolveModels } from '../../src/setup/setup-guide.ts';

// B54 (R3-export-setup-guide-untested): R-29 AC3, while setup is incomplete `/exportar` gets the
// setup guide (R-28), as every other message, and writes nothing.
const PRINCIPAL = 4242;
const principal = { chatId: PRINCIPAL };
const UNSET_GUIDE =
  '¡Hola! Me falta:\n- El modelo y el modelo de visión (ANOMANDER_MODEL y ANOMANDER_VISION_MODEL en el .env).';
const UNCONNECTED_GUIDE =
  '¡Hola! Me falta:\n- Conectar tu cuenta de ChatGPT (/login o su API key en el .env).';

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander | undefined;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

beforeEach(async () => {
  vi.clearAllMocks();
  scratch = mkdtempSync(join(tmpdir(), 'anomander-export-guide-'));
  api = await startFakeTelegramApi();
});

afterEach(async () => {
  await anomander?.stop();
  anomander = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Sends `/exportar` and answers what the bot sent for it, after the guide sent at start. */
const exportAfterGuide = async () => {
  await api.waitForSent(1);
  api.push(updates.text(principal, '/exportar'));
  const sent = await api.waitForSent(2);
  return sent[1]?.text;
};

describe('/exportar while setup is incomplete (R-29 AC3, R-28)', () => {
  it('with a provider not connected, the daemon replies the guide and writes no export', async () => {
    anomander = startAnomander(
      configWith({ ANOMANDER_MODEL: 'openai/gpt-5.5', ANOMANDER_VISION_MODEL: 'openai/gpt-5.5' }),
      {
        complete,
        model: 'openai/gpt-5.5',
        visionModel: 'openai/gpt-5.5',
        setupGaps: createConnectionGaps({
          providerIds: ['openai'],
          checkAuth: async () => undefined,
          logger,
        }),
        telegramApiRoot: api.apiRoot,
        logger,
      },
    );
    await anomander.started;

    expect(await exportAfterGuide()).toBe(UNCONNECTED_GUIDE);
    expect(api.documents).toEqual([]);
    expect(existsSync(join(scratch, 'exports'))).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('with no model set, the setup guide replies the guide and opens no store', async () => {
    const config = configWith({});
    const resolved = resolveModels(config, () => undefined);
    if (resolved.ready) throw new Error('expected model gaps');
    anomander = startSetupGuide(config, {
      gaps: resolved.gaps,
      telegramApiRoot: api.apiRoot,
      logger,
    });
    await anomander.started;

    expect(await exportAfterGuide()).toBe(UNSET_GUIDE);
    expect(api.documents).toEqual([]);
    expect(existsSync(join(scratch, 'exports'))).toBe(false);
    expect(existsSync(join(scratch, 'anomander.db'))).toBe(false);
  });
});
