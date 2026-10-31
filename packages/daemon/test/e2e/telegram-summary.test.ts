import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeTelegramApi, startFakeTelegramApi } from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// End to end (PRD §15): the weekly summary reaches the principal over the fake Telegram API from
// the composition root, verbatim and without the processor (R-10 AC2).
const PRINCIPAL = 4242;
const NOW = new Date('2026-11-01T19:00:00.000Z');

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-summary-'));
  api = await startFakeTelegramApi();
});

afterEach(async () => {
  await anomander.stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the weekly summary over Telegram', () => {
  it('sends S-9 verbatim to the principal at the configured cron, with no processor call', async () => {
    const dbPath = join(scratch, 'anomander.db');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO expenses (occurred_on, total_cents, category_id, mode, status, created_at)
       VALUES ('2026-10-31', 2300, (SELECT id FROM categories WHERE name = 'restaurantes'),
               'declared', 'current', ?)`,
    ).run(NOW.toISOString());
    db.close();
    const complete = vi.fn(async () => {
      throw new Error('the processor must not be called');
    });

    anomander = startAnomander(
      loadConfig({
        TELEGRAM_BOT_TOKEN: api.token,
        ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
        ANOMANDER_DB_PATH: dbPath,
        ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
        ANOMANDER_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
        // Every second, so the test does not wait for Sunday.
        ANOMANDER_WEEKLY_SUMMARY_CRON: '* * * * * *',
      }),
      {
        complete,
        model: 'openai/gpt-4o-mini',
        telegramApiRoot: api.apiRoot,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        now: () => NOW,
      },
    );
    await anomander.started;

    const [summary] = await api.waitForSent(1);
    expect(summary).toMatchObject({
      chatId: PRINCIPAL,
      text: 'Semana del 26 de octubre al 1 de noviembre: 23,00 €. Restaurantes 23,00 € · Supermercado 0,00 € · Sin clasificar 0,00 €. Pendientes de confirmar: 0.',
    });
    expect(complete).not.toHaveBeenCalled();
  });
});
