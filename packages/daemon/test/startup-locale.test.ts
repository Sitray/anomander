import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLocale, setLocale } from '@anomander/protocol';
import { type FakeTelegramApi, startFakeTelegramApi } from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Anomander, startAnomander, startSetupGuide } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

// S3: the daemon speaks the language of `ANOMANDER_LOCALE` from the moment it starts, before it
// builds any text, whether it runs the assistant or the setup guide.
let scratch: string;
let api: FakeTelegramApi;
let running: Anomander | undefined;

const config = (env: Record<string, string>) =>
  loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: '4242',
    ANOMANDER_DB_PATH: join(scratch, 'data', 'anomander.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ...env,
  });
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-locale-'));
  api = await startFakeTelegramApi();
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
  setLocale('es');
});

describe('the language at startup', () => {
  it('the setup guide speaks ANOMANDER_LOCALE', () => {
    running = startSetupGuide(config({ ANOMANDER_LOCALE: 'en' }), {
      gaps: [{ kind: 'model_unset' }],
      telegramApiRoot: api.apiRoot,
      logger: logger(),
    });
    expect(getLocale()).toBe('en');
  });

  it('the assistant speaks ANOMANDER_LOCALE, and Spanish without it', async () => {
    setLocale('en');
    running = startAnomander(
      config({ ANOMANDER_MODEL: 'openai/gpt-4o-mini', ANOMANDER_VISION_MODEL: 'openai/x' }),
      {
        complete: async () => {
          throw new Error('no processor call is expected');
        },
        model: 'openai/gpt-4o-mini',
        telegramApiRoot: api.apiRoot,
        logger: logger(),
      },
    );
    expect(getLocale()).toBe('es');
    await running.stop();

    running = startAnomander(
      config({
        ANOMANDER_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_VISION_MODEL: 'openai/x',
        ANOMANDER_LOCALE: 'en',
      }),
      {
        complete: async () => {
          throw new Error('no processor call is expected');
        },
        model: 'openai/gpt-4o-mini',
        telegramApiRoot: api.apiRoot,
        logger: logger(),
      },
    );
    expect(getLocale()).toBe('en');
  });
});
