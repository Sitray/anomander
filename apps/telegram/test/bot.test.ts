import type { Reply, TextHandler } from '@anomander/protocol';
import type { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelegramBot } from '../src/index.ts';
import {
  type FakeTelegramApi,
  type IncomingUpdate,
  MESSAGE_DATE,
  type Sender,
  startFakeTelegramApi,
  updates,
} from '../test-support/fake-telegram-api.ts';

const PRINCIPAL = 4242;
const STRANGER = 9999;
const principal: Sender = { chatId: PRINCIPAL };

let api: FakeTelegramApi;
let bot: Bot;
let polling: Promise<void>;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const onDelivered = vi.fn();
const onText = vi.fn<TextHandler>(
  async (): Promise<Reply> => ({ text: 'Apuntado: 23,00 € (sin clasificar).', onDelivered }),
);

beforeEach(async () => {
  vi.clearAllMocks();
  api = await startFakeTelegramApi();
  bot = createTelegramBot({
    token: api.token,
    apiRoot: api.apiRoot,
    principalChatId: PRINCIPAL,
    onText,
    logger,
  });
  await new Promise<void>((started) => {
    polling = bot.start({ onStart: () => started() });
  });
});

afterEach(async () => {
  await bot.stop();
  await polling;
  await api.close();
});

/** Updates are handled in order, so once the principal's next text is answered, the update
 * pushed before it has been handled too. */
const pushThenSettle = async (update: IncomingUpdate) => {
  api.push(update);
  api.push(updates.text(principal, 'después'));
  return api.waitForSent(1);
};

describe('principal text (R-17 AC5)', () => {
  it('reaches the daemon, its reply is sent to the chat and its delivery is reported', async () => {
    const update = updates.text(principal, '23 € cena');
    api.push(update);

    const [reply] = await api.waitForSent(1);

    expect(onText).toHaveBeenCalledExactlyOnceWith({
      text: '23 € cena',
      channelRef: `telegram:${update.message?.message_id}`,
      receivedAt: new Date(MESSAGE_DATE * 1000).toISOString(),
    });
    expect(reply).toMatchObject({ chatId: PRINCIPAL, text: 'Apuntado: 23,00 € (sin clasificar).' });
    await vi.waitFor(() =>
      expect(onDelivered).toHaveBeenCalledExactlyOnceWith({
        channelRef: `telegram:${reply?.messageId}`,
        deliveredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      }),
    );
  });
});

describe('R-1 principal-only access', () => {
  it.each([
    ['another private chat', { chatId: STRANGER }],
    ['the principal in a group', { chatId: -100, fromId: PRINCIPAL, chatType: 'group' }],
    ['another sender in the principal chat', { chatId: PRINCIPAL, fromId: STRANGER }],
  ] as const)('ignores %s and logs it at warn', async (_, sender: Sender) => {
    const sent = await pushThenSettle(updates.text(sender, '23 € cena'));

    expect(sent).toHaveLength(1);
    expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'después' }));
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      chatId: sender.chatId,
      senderId: sender.fromId ?? sender.chatId,
    });
  });
});

describe('R-20 supported inputs', () => {
  it('answers a PDF with S-18', async () => {
    api.push(updates.document(principal, 'application/pdf'));

    const [reply] = await api.waitForSent(1);

    expect(reply?.text).toBe('Todavía no leo PDF. ¿Me mandas una foto del ticket?');
    expect(onText).not.toHaveBeenCalled();
  });

  it.each([
    ['voice', updates.voice(principal)],
    ['video', updates.video(principal)],
    ['sticker', updates.sticker(principal)],
    ['location', updates.location(principal)],
    ['contact', updates.contact(principal)],
    ['a non-image document', updates.document(principal, 'application/zip')],
  ])('answers %s with S-17', async (_, update) => {
    api.push(update);

    const [reply] = await api.waitForSent(1);

    expect(reply?.text).toBe('De momento solo entiendo texto y fotos de tickets.');
    expect(onText).not.toHaveBeenCalled();
  });

  it('ignores an edited message and logs it at info', async () => {
    const update = updates.edited(principal, '24 € cena');

    const sent = await pushThenSettle(update);

    expect(sent).toHaveLength(1);
    expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'después' }));
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      chatId: PRINCIPAL,
      messageId: update.edited_message?.message_id,
    });
  });

  it.each([
    ['a photo', updates.photo(principal, 20 * 1024 * 1024 + 1)],
    ['an image file', updates.document(principal, 'image/jpeg', 20 * 1024 * 1024 + 1)],
  ])('answers %s larger than 20 MB with S-20', async (_, update) => {
    api.push(update);

    const [reply] = await api.waitForSent(1);

    expect(reply?.text).toBe('La imagen es demasiado grande. ¿Me mandas una foto más ligera?');
  });
});
