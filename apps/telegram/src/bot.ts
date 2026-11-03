// The Telegram front door: decides who may talk (R-1) and which inputs are supported (R-20).
// What a text, a receipt or a button press means is the daemon's decision, reached through
// `onText`, `onReceipt` and `onButton`.

import {
  type ButtonPress,
  type PrincipalReceipt,
  type PrincipalText,
  type ReceiptHandler,
  type ReceiptImage,
  type Reply,
  type ReplyButton,
  strings,
} from '@anomander/protocol';
import { type Api, Bot, type Context, type Transformer } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';

export interface TelegramLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** A button that opens `url` instead of coming back as a press, such as `Abrir` (R-27 AC2). */
export interface LinkButton {
  label: string;
  url: string;
}

export type TelegramButton = ReplyButton | LinkButton;

/** A `Reply` whose buttons may also be links. */
export type TelegramReply = Omit<Reply, 'buttons'> & { buttons?: readonly TelegramButton[] };

/**
 * The daemon's answer to a text or a press. `null` sends nothing, such as a pasted login code
 * whose outcome the daemon sends later (R-27 AC3).
 */
export type TelegramTextHandler = (message: PrincipalText) => Promise<TelegramReply | null>;
export type TelegramButtonHandler = (press: ButtonPress) => Promise<TelegramReply | null>;

export interface TelegramBotOptions {
  token: string;
  /** `ANOMANDER_PRINCIPAL_CHAT_ID`: the principal's private chat ID, equal to their user ID. */
  principalChatId: number;
  onText: TelegramTextHandler;
  /** Photos and image files (R-3, R-20). */
  onReceipt: ReceiptHandler;
  /**
   * Presses on the buttons of a pending decision (R-17 AC1) or of a login (R-27). Without it,
   * presses are ignored.
   */
  onButton?: TelegramButtonHandler;
  /** Points grammY at another Bot API server, such as the fake one in tests. */
  apiRoot?: string;
  logger?: TelegramLogger;
}

// Telegram's bot download limit (R-20).
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// R-3 AC4: an album is collected for 2 seconds after its first photo arrives.
const ALBUM_WINDOW_MS = 2000;
const TELEGRAM_API_ROOT = 'https://api.telegram.org';
// A reply Telegram refused for a moment (429, 5xx) is sent again rather than lost.
const SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
/** A longer `retry_after` gives up: the handler's turn would block for that long. */
const MAX_RETRY_AFTER_S = 30;
// R-22 AC1: the principal always gets an answer, even when the daemon fails.
const FAILED: Reply = { text: strings.processingFailed() };

const channelRef = (messageId: number) => `telegram:${messageId}`;
const receivedAt = (message: Message) => new Date(message.date * 1000).toISOString();

/** What R-20 does with a message that is not text: a reply, or a receipt image. */
type NonTextInput =
  | { kind: 'reply'; text: string }
  | { kind: 'receipt'; fileId: string; mimeType: string };

const classify = (message: Message): NonTextInput => {
  const { document, photo } = message;
  if (document?.mime_type === 'application/pdf') {
    return { kind: 'reply', text: strings.pdfNotSupported() };
  }
  // Telegram lists a photo's sizes smallest first and re-encodes photos as JPEG.
  const image =
    photo !== undefined
      ? { file: photo.at(-1), mimeType: 'image/jpeg' }
      : document?.mime_type?.startsWith('image/') === true
        ? { file: document, mimeType: document.mime_type }
        : undefined;
  if (image?.file === undefined) return { kind: 'reply', text: strings.unsupportedInput() };
  const size = Math.max(0, ...(photo ?? [document]).map((file) => file?.file_size ?? 0));
  return size > MAX_FILE_BYTES
    ? { kind: 'reply', text: strings.imageTooLarge() }
    : { kind: 'receipt', fileId: image.file.file_id, mimeType: image.mimeType };
};

const keyboard = (reply: TelegramReply): { reply_markup: InlineKeyboardMarkup } | undefined =>
  reply.buttons === undefined || reply.buttons.length === 0
    ? undefined
    : {
        reply_markup: {
          inline_keyboard: [
            reply.buttons.map((button) =>
              'url' in button
                ? { text: button.label, url: button.url }
                : { text: button.label, callback_data: button.data },
            ),
          ],
        },
      };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries `sendMessage` when Telegram answers 429 (after its `retry_after`, up to 30 s) or 5xx. A network
 * error is not retried: the message may have been sent, and a reply must not arrive twice.
 */
const retryRefusedSends: Transformer = async (prev, method, payload, signal) => {
  for (let attempt = 1; ; attempt++) {
    const result = await prev(method, payload, signal);
    const refused = !result.ok && (result.error_code === 429 || result.error_code >= 500);
    if (method !== 'sendMessage' || !refused || attempt === SEND_ATTEMPTS) return result;
    const retryAfter = result.parameters?.retry_after;
    if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) return result;
    await sleep(retryAfter === undefined ? RETRY_DELAY_MS * attempt : retryAfter * 1000);
  }
};

/** Sends a reply, with its buttons, and reports the delivery (R-9 AC2, R-17 AC2). */
const deliverReply = async (api: Api, chatId: number, reply: TelegramReply): Promise<void> => {
  const sent = await api.sendMessage(chatId, reply.text, keyboard(reply));
  reply.onDelivered?.({
    channelRef: channelRef(sent.message_id),
    deliveredAt: new Date().toISOString(),
  });
};

/**
 * The daemon's way to message the principal unasked, such as S-13 or S-14 (R-8, R-19), through
 * the bot that `createTelegramBot` returned.
 */
export const createTelegramNotify =
  (bot: Bot, principalChatId: number): ((message: TelegramReply) => Promise<void>) =>
  (message) =>
    deliverReply(bot.api, principalChatId, message);

/**
 * Deletes a message of the principal's chat by its `telegram:<message_id>`, such as a pasted login
 * code once read (R-27 AC3).
 */
export const createTelegramDelete =
  (bot: Bot, principalChatId: number): ((channelRef: string) => Promise<void>) =>
  async (ref) => {
    const messageId = Number(/^telegram:(\d+)$/.exec(ref)?.[1]);
    if (!Number.isSafeInteger(messageId)) throw new Error(`not a Telegram message: ${ref}`);
    await bot.api.deleteMessage(principalChatId, messageId);
  };

export const createTelegramBot = (options: TelegramBotOptions): Bot => {
  const { principalChatId, onText, onReceipt, onButton, logger = console } = options;
  const bot = new Bot(
    options.token,
    options.apiRoot === undefined ? {} : { client: { apiRoot: options.apiRoot } },
  );
  bot.api.config.use(retryRefusedSends);
  const fileRoot = `${options.apiRoot ?? TELEGRAM_API_ROOT}/file/bot${options.token}`;

  /** Downloads a file on demand, through the same Bot API server (the fake one in tests). */
  const download = async (fileId: string): Promise<Uint8Array> => {
    const file = await bot.api.getFile(fileId);
    if (file.file_path === undefined) throw new Error(`Telegram gave no path for ${fileId}`);
    const response = await fetch(`${fileRoot}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  const deliver = (chatId: number, reply: TelegramReply) => deliverReply(bot.api, chatId, reply);

  const handleReceipt = async (chatId: number, receipt: PrincipalReceipt) => {
    let reply: Reply | null;
    try {
      reply = await onReceipt(receipt);
    } catch (error) {
      logger.error('The daemon failed to handle a receipt', {
        channelRef: receipt.channelRef,
        error,
      });
      reply = FAILED;
    }
    if (reply !== null) await deliver(chatId, reply);
  };

  // R-3 AC4: the photos of an album arrive as separate updates sharing `media_group_id`.
  // Collecting them is Telegram transport, so it happens here, not in the daemon.
  const albums = new Map<string, { chatId: number; receipt: PrincipalReceipt }>();
  const collectAlbum = (chatId: number, message: Message, groupId: string, image: ReceiptImage) => {
    let album = albums.get(groupId);
    if (album === undefined) {
      const receipt: PrincipalReceipt = {
        images: [],
        caption: null,
        channelRef: `telegram:album:${groupId}`,
        receivedAt: receivedAt(message),
      };
      album = { chatId, receipt };
      albums.set(groupId, album);
      setTimeout(() => {
        albums.delete(groupId);
        handleReceipt(chatId, receipt).catch((error: unknown) => {
          logger.error('Failed to answer an album', { mediaGroupId: groupId, error });
        });
      }, ALBUM_WINDOW_MS);
    }
    album.receipt.images.push(image);
    if (message.caption !== undefined) {
      const { caption } = album.receipt;
      album.receipt.caption = caption === null ? message.caption : `${caption}\n${message.caption}`;
    }
  };

  const isPrincipal = (ctx: Context) =>
    ctx.chat?.type === 'private' &&
    ctx.chat.id === principalChatId &&
    ctx.from?.id === principalChatId;

  // R-1: before anything else, for every update kind.
  bot.use(async (ctx, next) => {
    if (isPrincipal(ctx)) return next();
    logger.warn('Ignored a message that does not come from the principal (R-1)', {
      chatId: ctx.chat?.id,
      senderId: ctx.from?.id,
    });
  });

  bot.on('edited_message', (ctx) => {
    logger.info('Ignored an edited message (R-20)', {
      chatId: ctx.chat.id,
      messageId: ctx.editedMessage.message_id,
    });
  });

  bot.on('message', async (ctx) => {
    const { message } = ctx;
    if (message.text === undefined) {
      const input = classify(message);
      if (input.kind === 'reply') {
        await ctx.api.sendMessage(ctx.chat.id, input.text);
        return;
      }
      // R-3: a photo or an image file is a receipt; its bytes are downloaded when read.
      const image: ReceiptImage = {
        mimeType: input.mimeType,
        load: () => download(input.fileId),
      };
      if (message.media_group_id !== undefined) {
        collectAlbum(ctx.chat.id, message, message.media_group_id, image);
        return;
      }
      await handleReceipt(ctx.chat.id, {
        images: [image],
        caption: message.caption ?? null,
        channelRef: channelRef(message.message_id),
        receivedAt: receivedAt(message),
      });
      return;
    }

    let reply: TelegramReply | null;
    try {
      const replyTo = message.reply_to_message?.message_id;
      reply = await onText({
        text: message.text,
        channelRef: channelRef(message.message_id),
        receivedAt: receivedAt(message),
        // R-17 AC2: a Telegram reply to a decision's message corrects that decision.
        ...(replyTo === undefined ? {} : { replyTo: channelRef(replyTo) }),
      });
    } catch (error) {
      logger.error('The daemon failed to handle a text', {
        channelRef: channelRef(message.message_id),
        error,
      });
      reply = FAILED;
    }
    if (reply !== null) await deliver(ctx.chat.id, reply);
  });

  // R-17 AC1: a press carries its decision in the data; the daemon decides what it answers.
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery();
    const { data, message } = ctx.callbackQuery;
    if (onButton === undefined || message === undefined) {
      logger.info('Ignored a button press with no handler', { data });
      return;
    }
    const ref = channelRef(message.message_id);
    let reply: TelegramReply | null;
    try {
      reply = await onButton({ data, channelRef: ref, pressedAt: new Date().toISOString() });
    } catch (error) {
      logger.error('The daemon failed to handle a button press', { channelRef: ref, error });
      reply = FAILED;
    }
    if (reply !== null) await deliver(ctx.chat?.id ?? principalChatId, reply);
  });

  // Without this, grammY stops polling on the first failed update.
  bot.catch((error) => {
    logger.error('Failed to handle a Telegram update', {
      updateId: error.ctx.update.update_id,
      error: error.error,
    });
  });

  return bot;
};
