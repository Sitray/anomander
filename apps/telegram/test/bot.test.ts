import type { PrincipalReceipt, ReceiptHandler, Reply, TextHandler } from '@anomander/protocol';
import type { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelegramBot } from '../src/index.ts';
import {
  type FakeTelegramApi,
  type IncomingUpdate,
  MESSAGE_DATE,
  pngBytes,
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
const QUESTION = 'No cuadra: las líneas suman 20,00 € y el total dice 23,40 €. ¿Qué hago?';
const BUTTONS = [
  { label: 'Apuntar', data: 'decision:7:0' },
  { label: 'Corregir', data: 'decision:7:1' },
  { label: 'Descartar', data: 'decision:7:2' },
];
const onReceipt = vi.fn<ReceiptHandler>(
  async (): Promise<Reply> => ({ text: QUESTION, buttons: BUTTONS, onDelivered }),
);

beforeEach(async () => {
  vi.clearAllMocks();
  api = await startFakeTelegramApi();
  bot = createTelegramBot({
    token: api.token,
    apiRoot: api.apiRoot,
    principalChatId: PRINCIPAL,
    onText,
    onReceipt,
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
    ['a photo', updates.photo(principal, { fileSize: 20 * 1024 * 1024 + 1 })],
    [
      'an image file',
      updates.document(principal, 'image/jpeg', { fileSize: 20 * 1024 * 1024 + 1 }),
    ],
  ])('answers %s larger than 20 MB with S-20', async (_, update) => {
    api.push(update);

    const [reply] = await api.waitForSent(1);

    expect(reply?.text).toBe('La imagen es demasiado grande. ¿Me mandas una foto más ligera?');
  });
});

describe('R-20 receipts (R-3)', () => {
  const loaded = async (receipt: PrincipalReceipt | undefined) =>
    Promise.all((receipt?.images ?? []).map(async (image) => [image.mimeType, await image.load()]));

  it('Photo: hands the largest size to the daemon and sends its buttons', async () => {
    api.putFile('receipt', pngBytes(10));
    api.putFile('receipt-small', pngBytes(99));
    const update = updates.photo(principal, { fileId: 'receipt' });
    api.push(update);

    const [reply] = await api.waitForSent(1);

    expect(onReceipt).toHaveBeenCalledExactlyOnceWith({
      images: [{ mimeType: 'image/jpeg', load: expect.any(Function) }],
      caption: null,
      channelRef: `telegram:${update.message?.message_id}`,
      receivedAt: new Date(MESSAGE_DATE * 1000).toISOString(),
    });
    expect(await loaded(onReceipt.mock.calls[0]?.[0])).toEqual([['image/jpeg', pngBytes(10)]]);
    expect(onText).not.toHaveBeenCalled();
    expect(reply?.text).toBe(QUESTION);
    expect(reply?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Apuntar', callback_data: 'decision:7:0' },
          { text: 'Corregir', callback_data: 'decision:7:1' },
          { text: 'Descartar', callback_data: 'decision:7:2' },
        ],
      ],
    });
    await vi.waitFor(() =>
      expect(onDelivered).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ channelRef: `telegram:${reply?.messageId}` }),
      ),
    );
  });

  it('Image as file: an image/* document is a receipt', async () => {
    api.putFile('scan', pngBytes(20));
    api.push(updates.document(principal, 'image/png', { fileId: 'scan' }));

    await api.waitForSent(1);

    expect(onReceipt).toHaveBeenCalledOnce();
    expect(await loaded(onReceipt.mock.calls[0]?.[0])).toEqual([['image/png', pngBytes(20)]]);
  });

  it('Album: photos with one media_group_id are one receipt, collected for 2 s (R-3 AC4)', async () => {
    api.putFile('page-1', pngBytes(1));
    api.putFile('page-2', pngBytes(2));
    api.push(updates.photo(principal, { fileId: 'page-1', mediaGroupId: 'album-9' }));
    api.push(updates.photo(principal, { fileId: 'page-2', mediaGroupId: 'album-9' }));

    await api.waitForSent(1, 5000);

    expect(onReceipt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channelRef: 'telegram:album:album-9', caption: null }),
    );
    expect(await loaded(onReceipt.mock.calls[0]?.[0])).toEqual([
      ['image/jpeg', pngBytes(1)],
      ['image/jpeg', pngBytes(2)],
    ]);
  });

  it('Caption: the caption on a photo reaches the daemon as the declaration (R-3 AC5)', async () => {
    api.putFile('receipt', pngBytes(30));
    api.push(updates.photo(principal, { fileId: 'receipt', caption: 'cena, restaurantes' }));

    await api.waitForSent(1);

    expect(onReceipt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ caption: 'cena, restaurantes' }),
    );
  });
});

describe('fake Telegram API', () => {
  it('resolves waitForSent at once when enough messages were already sent', async () => {
    api.push(updates.voice(principal));
    await api.waitForSent(1);

    const started = performance.now();
    await api.waitForSent(1, 10_000);

    expect(performance.now() - started).toBeLessThan(500);
  });
});
