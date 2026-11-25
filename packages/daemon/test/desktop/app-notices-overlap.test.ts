import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_CHANNEL_PROTOCOL } from '@anomander/protocol';
import { type FakeTelegramApi, startFakeTelegramApi } from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { createAiBudget } from '../../src/budget/ai-budget.ts';
import { loadConfig } from '../../src/config.ts';
import { createReceiptExpenseCycle } from '../../src/expenses/receipt-expense.ts';
import { verbatimReplies } from '../../src/processor/reply-phraser.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// DK-22 AC2 (verifier probe): the jobs run when the app connects stay one at a time with the
// scheduler's ("Jobs never overlap"). The scheduler's startup `retain` is slowed by Telegram
// refusing S-14 twice; an app connects meanwhile. A queued receipt must not be read before
// `retain` finished, or a receipt read as it expires could lose its images mid-read.
const TOKEN = 'probe-overlap-token-0123456789abcdef0123';
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-10-31T10:00:00.000Z');
const S14 = 'He borrado sin leer el ticket';

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander | undefined;
let socket: WebSocket | undefined;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const queue = async (dbPath: string, inbox: string, receivedAt: string) => {
  const db = openDatabase(dbPath);
  applyMigrations(db);
  const at = () => new Date(receivedAt);
  await createReceiptExpenseCycle({
    db,
    reader: async () => {
      throw new Error('not read here');
    },
    budget: createAiBudget({ db, limit: 0, timeZone: TZ, now: at }),
    inboxDir: inbox,
    timeZone: TZ,
    now: at,
    processorSource: 'processor:openai/gpt-4o',
    phraser: verbatimReplies,
    logger,
  }).onReceipt({
    images: [{ mimeType: 'image/jpeg', load: async () => new Uint8Array([1]) }],
    caption: null,
    channelRef: 'telegram:7',
    receivedAt,
  });
  db.close();
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-probe-'));
  api = await startFakeTelegramApi();
});

afterEach(async () => {
  socket?.close();
  await anomander?.stop();
  anomander = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

it('S-168: a queued receipt is not read on connect while the scheduler still runs retain', async () => {
  const dbPath = join(scratch, 'anomander.db');
  const inbox = join(scratch, 'inbox');
  // Expired yesterday: retain tells S-14. Waiting: the drain reads it.
  await queue(dbPath, inbox, '2026-10-30T09:00:00.000Z');
  await queue(dbPath, inbox, '2026-10-31T09:30:00.000Z');
  api.refuseNextSends(2, 500);
  let sentAtFirstRead: string[] | undefined;
  anomander = startAnomander(
    {
      ...loadConfig({
        TELEGRAM_BOT_TOKEN: api.token,
        ANOMANDER_PRINCIPAL_CHAT_ID: '4242',
        ANOMANDER_LOCAL_TOKEN: TOKEN,
        ANOMANDER_DB_PATH: dbPath,
        ANOMANDER_INBOX_DIR: inbox,
        ANOMANDER_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
        TZ,
      }),
      localPort: 0,
    },
    {
      complete: async () => {
        sentAtFirstRead ??= api.sent.map((sent) => sent.text);
        throw new Error('probe: no processor');
      },
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      now: () => NOW,
    },
  );
  const address = await anomander.localChannel;
  if (address === undefined) throw new Error('no local channel');
  socket = new WebSocket(`ws://${address.host}:${address.port}`, [LOCAL_CHANNEL_PROTOCOL, TOKEN]);
  await new Promise<void>((resolve) => socket?.addEventListener('open', () => resolve()));

  await vi.waitFor(() => expect(sentAtFirstRead).toBeDefined(), { timeout: 10_000 });
  // The drain started only after retain told S-14 (the scheduler's order).
  expect(sentAtFirstRead?.some((text) => text.startsWith(S14))).toBe(true);
});
