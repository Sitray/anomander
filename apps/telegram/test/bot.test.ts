import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ButtonHandler,
  PrincipalReceipt,
  ReceiptHandler,
  Reply,
  TextHandler,
} from '@anomander/protocol';
import type { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelegramBot, createTelegramNotify, haltTelegramBot } from '../src/index.ts';
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
const onButton = vi.fn<ButtonHandler>(
  async (): Promise<Reply> => ({ text: 'Esa pregunta ya no está abierta.', onDelivered }),
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
    onButton,
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

describe('files (R-29 AC3)', () => {
  it('sends the text, then each file of the reply as a document with its name', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'anomander-bot-files-'));
    try {
      writeFileSync(join(folder, 'a.csv'), 'x,y\r\n1,2\r\n');
      writeFileSync(join(folder, 'b.json'), '{"ok":true}\n');
      onText.mockResolvedValueOnce({
        text: 'Aquí tienes tus datos.',
        files: [
          { path: join(folder, 'a.csv'), name: 'gastos.csv' },
          { path: join(folder, 'b.json'), name: 'ledger.json' },
        ],
      });
      api.push(updates.text(principal, '/exportar'));

      const [reply] = await api.waitForSent(1);
      const documents = await api.waitForDocuments(2);

      expect(reply?.text).toBe('Aquí tienes tus datos.');
      expect(
        documents.map(({ chatId, fileName, bytes }) => ({
          chatId,
          fileName,
          text: new TextDecoder().decode(bytes),
        })),
      ).toEqual([
        { chatId: PRINCIPAL, fileName: 'gastos.csv', text: 'x,y\r\n1,2\r\n' },
        { chatId: PRINCIPAL, fileName: 'ledger.json', text: '{"ok":true}\n' },
      ]);
      // The documents come after the text.
      expect(documents[0]?.messageId).toBeGreaterThan(reply?.messageId ?? Number.POSITIVE_INFINITY);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('files that Telegram refuses (R-29 AC3)', () => {
  const withFiles = async (run: (folder: string) => Promise<void>) => {
    const folder = mkdtempSync(join(tmpdir(), 'anomander-bot-refused-'));
    try {
      writeFileSync(join(folder, 'a.csv'), 'a');
      writeFileSync(join(folder, 'b.json'), 'b');
      onText.mockResolvedValueOnce({
        text: 'Aquí tienes tus datos.',
        files: [
          { path: join(folder, 'a.csv'), name: 'gastos.csv' },
          { path: join(folder, 'b.json'), name: 'ledger.json' },
        ],
        filesFailed: 'No he podido exportar tus datos.',
      });
      await run(folder);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };

  it('sends a document again when Telegram refuses it for a moment', async () => {
    await withFiles(async () => {
      api.refuseNextDocuments(1, 500);
      api.push(updates.text(principal, '/exportar'));

      const documents = await api.waitForDocuments(2, 5000);

      expect(documents.map((document) => document.fileName)).toEqual(['gastos.csv', 'ledger.json']);
      expect(api.sent.map((message) => message.text)).toEqual(['Aquí tienes tus datos.']);
    });
  });

  it('sends filesFailed when a document is still refused, and logs no path', async () => {
    await withFiles(async (folder) => {
      api.refuseNextDocuments(3, 500);
      api.push(updates.text(principal, '/exportar'));

      const sent = await api.waitForSent(2, 5000);

      expect(sent.map((message) => message.text)).toEqual([
        'Aquí tienes tus datos.',
        'No he podido exportar tus datos.',
      ]);
      expect(api.documents).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith('Failed to send a file', {
        file: 'gastos.csv',
        reason: expect.anything(),
      });
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(folder);
    });
  });
});

describe('R-22 failure reply', () => {
  it('AC1: when the daemon fails, the principal gets S-22 and the error is logged', async () => {
    onText.mockRejectedValueOnce(new Error('store is locked'));
    api.push(updates.text(principal, '23 € cena'));

    const [reply] = await api.waitForSent(1);

    expect(reply?.text).toBe(
      'Algo ha fallado y no he podido procesar tu mensaje. ¿Me lo vuelves a enviar en un rato?',
    );
    expect(logger.error).toHaveBeenCalledWith(
      'The daemon failed to handle a text',
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it('sends a reply again when Telegram refuses it for a moment', async () => {
    api.refuseNextSends(1, 500);
    api.push(updates.text(principal, '23 € cena'));

    const sent = await api.waitForSent(1);

    expect(sent.map((message) => message.text)).toEqual(['Apuntado: 23,00 € (sin clasificar).']);
    await vi.waitFor(() => expect(onDelivered).toHaveBeenCalledOnce());
  });
});

// B82: a crash halts the bot while the daemon drains its log. A text whose turn never started is
// not acknowledged, so Telegram hands it over again once the daemon is back; what was handled is.
describe('halting the bot (B82)', () => {
  /** A second bot on the same Bot API, as the daemon restarted; the texts it was handed. */
  const restart = async () => {
    const handed: string[] = [];
    const next = createTelegramBot({
      token: api.token,
      apiRoot: api.apiRoot,
      principalChatId: PRINCIPAL,
      onText: async ({ text }) => {
        handed.push(text);
        return { text: `visto: ${text}` };
      },
      onReceipt,
      onButton,
      logger,
    });
    const nextPolling = next.start();
    return {
      handed,
      stop: async () => {
        await next.stop();
        await nextPolling;
      },
    };
  };

  /** Handles `uno`, then holds `dos` in a turn until it is refused or answered. */
  const holdSecondText = async () => {
    api.push(updates.text(principal, 'uno'));
    await api.waitForSent(1);
    let refuse = (_: Error): void => {};
    let answer = (_: Reply): void => {};
    onText.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          refuse = reject;
          answer = resolve;
        }),
    );
    api.push(updates.text(principal, 'dos'));
    await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(2));
    return Object.assign((error: Error) => refuse(error), {
      answer: (reply: Reply) => answer(reply),
    });
  };

  it('a text the daemon did not take while halted is handed over again after the restart', async () => {
    const refuse = await holdSecondText();

    const halted = haltTelegramBot(bot);
    refuse(new Error('ANOMANDER is stopping: this turn did not start'));
    await halted;
    await polling;

    // No failure reply: the text is not lost, only left for later.
    expect(api.sent.map(({ text }) => text)).toEqual(['Apuntado: 23,00 € (sin clasificar).']);
    const restarted = await restart();
    await api.waitForSent(2);
    await restarted.stop();
    expect(restarted.handed).toEqual(['dos']);
  });

  it('a text whose turn ran through the halt is answered and acknowledged, never handed over twice', async () => {
    const hold = await holdSecondText();

    const halted = haltTelegramBot(bot);
    hold.answer({ text: 'Apuntado: dos.' });
    await halted;
    await polling;

    await api.waitForSent(2);
    expect(api.sent.at(-1)?.text).toBe('Apuntado: dos.');
    const restarted = await restart();
    api.push(updates.text(principal, 'tres'));
    await api.waitForSent(3);
    await restarted.stop();
    expect(restarted.handed).toEqual(['tres']);
  });

  it('a stop still answers a text the daemon did not take and acknowledges it, as before', async () => {
    const refuse = await holdSecondText();

    const stopped = bot.stop();
    refuse(new Error('ANOMANDER is stopping: this turn did not start'));
    await stopped;
    await polling;

    await api.waitForSent(2);
    expect(api.sent.at(-1)?.text).toBe(
      'Algo ha fallado y no he podido procesar tu mensaje. ¿Me lo vuelves a enviar en un rato?',
    );
    const restarted = await restart();
    api.push(updates.text(principal, 'tres'));
    await api.waitForSent(3);
    await restarted.stop();
    expect(restarted.handed).toEqual(['tres']);
  });
});

describe('decisions (R-17 AC1, AC2)', () => {
  it('hands a button press to the daemon, answers the callback and sends the reply', async () => {
    api.push(updates.callbackQuery(principal, 'decision:7:0', 31));

    const [reply] = await api.waitForSent(1);

    expect(onButton).toHaveBeenCalledExactlyOnceWith({
      data: 'decision:7:0',
      channelRef: 'telegram:31',
      pressedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(api.answeredCallbacks).toHaveLength(1);
    expect(reply).toMatchObject({ chatId: PRINCIPAL, text: 'Esa pregunta ya no está abierta.' });
    await vi.waitFor(() => expect(onDelivered).toHaveBeenCalledOnce());
  });

  it('ignores a button press from anyone but the principal (R-1)', async () => {
    const sent = await pushThenSettle(
      updates.callbackQuery({ chatId: PRINCIPAL, fromId: STRANGER }, 'decision:7:0', 31),
    );

    expect(sent).toHaveLength(1);
    expect(onButton).not.toHaveBeenCalled();
    expect(api.answeredCallbacks).toEqual([]);
  });

  it('passes the replied-to message of a text as replyTo', async () => {
    api.push(updates.text(principal, 'total 28,40', { replyToMessageId: 31 }));
    await api.waitForSent(1);

    expect(onText).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: 'total 28,40', replyTo: 'telegram:31' }),
    );
  });

  it('notify sends a message to the principal with its buttons and reports the delivery', async () => {
    await createTelegramNotify(bot, PRINCIPAL)({ text: QUESTION, buttons: BUTTONS, onDelivered });

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({ chatId: PRINCIPAL, text: QUESTION });
    expect(api.sent[0]?.payload.reply_markup).toMatchObject({
      inline_keyboard: [expect.any(Array)],
    });
    expect(onDelivered).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channelRef: `telegram:${api.sent[0]?.messageId}` }),
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
