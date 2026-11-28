import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Reply, strings, type TextHandler } from '@anomander/protocol';
import type { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelegramBot } from '../src/index.ts';
import {
  type FakeTelegramApi,
  type Sender,
  startFakeTelegramApi,
  updates,
} from '../test-support/fake-telegram-api.ts';

// B54 (R3-partial-document-failure-path): R-29 AC3, a file Telegram refuses after others went out
// stops the rest and says so; the files already sent stay sent.
const PRINCIPAL = 4242;
const principal: Sender = { chatId: PRINCIPAL };

let api: FakeTelegramApi;
let bot: Bot;
let polling: Promise<void>;
let folder: string;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const onText = vi.fn<TextHandler>();

beforeEach(async () => {
  vi.clearAllMocks();
  folder = mkdtempSync(join(tmpdir(), 'anomander-bot-partial-'));
  api = await startFakeTelegramApi();
  bot = createTelegramBot({
    token: api.token,
    apiRoot: api.apiRoot,
    principalChatId: PRINCIPAL,
    onText,
    onReceipt: vi.fn(),
    onButton: vi.fn(),
    logger,
  });
  // The second document of a reply is refused for good (400 is not sent again).
  let documents = 0;
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === 'sendDocument') {
      documents += 1;
      if (documents === 2) api.refuseNextDocuments(1, 400);
    }
    return prev(method, payload, signal);
  });
  await new Promise<void>((started) => {
    polling = bot.start({ onStart: () => started() });
  });
});

afterEach(async () => {
  await bot.stop();
  await polling;
  await api.close();
  rmSync(folder, { recursive: true, force: true });
});

/** A reply with three files; Telegram refuses the second. */
const replyWithARefusedFile = (filesFailed?: string): Reply => {
  for (const name of ['a.csv', 'b.csv', 'c.json']) writeFileSync(join(folder, name), name);
  return {
    text: 'Aquí tienes tus datos.',
    files: [
      { path: join(folder, 'a.csv'), name: 'gastos.csv' },
      { path: join(folder, 'b.csv'), name: 'lineas_de_compra.csv' },
      { path: join(folder, 'c.json'), name: 'ledger.json' },
    ],
    ...(filesFailed === undefined ? {} : { filesFailed }),
  };
};

describe('a file that fails after others were sent (R-29 AC3)', () => {
  it('keeps the files sent before it, sends no file after it, says filesFailed and logs no path', async () => {
    onText.mockResolvedValueOnce(replyWithARefusedFile('No he podido exportar tus datos.'));
    api.push(updates.text(principal, '/exportar'));

    await api.waitForSent(2);
    // Updates are handled in order: once the next text is answered, that reply is done.
    onText.mockResolvedValueOnce({ text: 'Hecho.' });
    api.push(updates.text(principal, 'después'));
    const sent = await api.waitForSent(3);

    expect(sent.map((message) => message.text)).toEqual([
      'Aquí tienes tus datos.',
      'No he podido exportar tus datos.',
      'Hecho.',
    ]);
    expect(api.documents.map((document) => document.fileName)).toEqual(['gastos.csv']);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('Failed to send a file', {
      file: 'lineas_de_compra.csv',
      reason: 400,
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(folder);
  });

  it('without filesFailed, says S-22', async () => {
    onText.mockResolvedValueOnce(replyWithARefusedFile());
    api.push(updates.text(principal, '/exportar'));

    const sent = await api.waitForSent(2);

    expect(sent.map((message) => message.text)).toEqual([
      'Aquí tienes tus datos.',
      strings.processingFailed(),
    ]);
    expect(api.documents.map((document) => document.fileName)).toEqual(['gastos.csv']);
  });
});
