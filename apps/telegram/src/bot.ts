// The Telegram front door: decides who may talk (R-1) and which inputs are supported (R-20).
// What a text, a receipt or a button press means is the daemon's decision, reached through
// `onText`, `onReceipt` and `onButton`.

import {
  type ButtonPress,
  type DoorButton,
  type DoorReply,
  type PrincipalReceipt,
  type PrincipalText,
  type ReceiptHandler,
  type ReceiptImage,
  type Reply,
  strings,
} from '@anomander/protocol';
import { type Api, Bot, type Context, GrammyError, InputFile, type Transformer } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';

export interface TelegramLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type { LinkButton } from '@anomander/protocol';

/** `DoorButton` and `DoorReply` of `@anomander/protocol`, which every front door shares. */
export type TelegramButton = DoorButton;
export type TelegramReply = DoorReply;

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
// R-22 AC1: the principal always gets an answer, even when the daemon fails. Built when sent, so
// it is in the language the daemon chose at startup, not the one of this module's import.
const failed = (): Reply => ({ text: strings.processingFailed() });

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

// A message or a document, such as a file of the export (R-29 AC3), is sent again when refused.
const RETRIED_METHODS = new Set(['sendMessage', 'sendDocument']);

/**
 * Retries `sendMessage` and `sendDocument` when Telegram answers 429 (after its `retry_after`, up to 30 s) or 5xx. A network
 * error is not retried: the message may have been sent, and a reply must not arrive twice.
 */
const retryRefusedSends: Transformer = async (prev, method, payload, signal) => {
  for (let attempt = 1; ; attempt++) {
    const result = await prev(method, payload, signal);
    const refused = !result.ok && (result.error_code === 429 || result.error_code >= 500);
    if (!RETRIED_METHODS.has(method) || !refused || attempt === SEND_ATTEMPTS) return result;
    const retryAfter = result.parameters?.retry_after;
    if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) return result;
    await sleep(retryAfter === undefined ? RETRY_DELAY_MS * attempt : retryAfter * 1000);
  }
};

/** Why a file was not sent, without its path: Telegram's error code, or the file system's. */
const failureReason = (error: unknown): string | number =>
  error instanceof GrammyError
    ? error.error_code
    : ((error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : 'unknown'));

/**
 * Sends a reply, with its buttons, and reports the delivery (R-9 AC2, R-17 AC2); then each of its
 * files as a document, in order (R-29 AC3). The first file Telegram still refuses stops the rest
 * and sends `filesFailed`, or S-22 without it.
 */
const deliverReply = async (
  api: Api,
  chatId: number,
  reply: TelegramReply,
  logger: TelegramLogger = console,
): Promise<void> => {
  const sent = await api.sendMessage(chatId, reply.text, keyboard(reply));
  reply.onDelivered?.({
    channelRef: channelRef(sent.message_id),
    deliveredAt: new Date().toISOString(),
  });
  for (const file of reply.files ?? []) {
    try {
      await api.sendDocument(chatId, new InputFile(file.path, file.name));
    } catch (error) {
      logger.error('Failed to send a file', { file: file.name, reason: failureReason(error) });
      await api.sendMessage(chatId, reply.filesFailed ?? failed().text);
      return;
    }
  }
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

/**
 * B82: the `code` of a handler's error that says the daemon refused the input because its turn
 * never started (the daemon is stopping), so nothing of it ran. Only a text or a receipt
 * refused so during a crash halt is left for Telegram to hand over again.
 */
export const TURN_NOT_STARTED = 'ANOMANDER_TURN_NOT_STARTED';

const isTurnNotStarted = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === TURN_NOT_STARTED;

/**
 * B84: how long a crash halt waits for the update it is handling to settle before it acknowledges
 * it: a refusal the halt caused comes well within it, through I/O included, while a turn that
 * runs is acknowledged once it passed. A refusal later than that gets S-22, and says so.
 */
export const HALT_REFUSAL_LIMIT_MS = 250;

/**
 * B82: what a crash halt knows of a bot: whether it is halted, the update it began to handle
 * last before that and its handling (B84), whether the daemon refused that one
 * (`TURN_NOT_STARTED`), the offset it acknowledged once halted, and the stop the halt began.
 */
interface HaltState {
  halted: boolean;
  started: number | undefined;
  handling: Promise<void> | undefined;
  refused: boolean;
  acknowledged: number | undefined;
  stopped: Promise<void>;
}
const haltStates = new WeakMap<Bot, HaltState>();

/** Resolves once `work` settles or `limitMs` passed, whichever is first; at once without work. */
const settledWithin = async (work: Promise<void> | undefined, limitMs: number): Promise<void> => {
  if (work === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limitMs);
  });
  try {
    await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
};

/** Out of a handler while halted: the daemon did not take the update, so it is left for later. */
class NotTaken extends Error {}

/**
 * B82: stops polling as a crash does. Like `bot.stop()`, it acknowledges every update the bot
 * began to handle, the one still running included, so nothing that ran comes again; unlike it,
 * a text or a receipt the daemon refused with `TURN_NOT_STARTED` gets no reply and is not
 * acknowledged, nor is an update read after the halt, so Telegram hands them over again once the
 * daemon is back. A button press keeps `bot.stop()`'s answer: Telegram rejects an old press.
 * B84: halted in the call itself, so a refusal given in the same tick is read as the halt's; the
 * acknowledgement waits for the update being handled at most `HALT_REFUSAL_LIMIT_MS`.
 */
export const haltTelegramBot = (bot: Bot): Promise<void> => {
  const state = haltStates.get(bot);
  if (state === undefined) return bot.stop();
  if (!state.halted) {
    state.halted = true;
    state.stopped = bot.stop();
  }
  return state.stopped;
};

/**
 * Whether polling stopped because Telegram answered `409 Conflict`: another process, such as a
 * Docker install, reads the same bot (DK-2 AC2).
 */
export const isBotInUse = (error: unknown): boolean =>
  error instanceof GrammyError && error.error_code === 409;

export const createTelegramBot = (options: TelegramBotOptions): Bot => {
  const { principalChatId, onText, onReceipt, onButton, logger = console } = options;
  const bot = new Bot(
    options.token,
    options.apiRoot === undefined ? {} : { client: { apiRoot: options.apiRoot } },
  );
  bot.api.config.use(retryRefusedSends);
  const halt: HaltState = {
    halted: false,
    started: undefined,
    handling: undefined,
    refused: false,
    acknowledged: undefined,
    stopped: Promise.resolve(),
  };
  haltStates.set(bot, halt);
  // B82: once halted, the `getUpdates` `bot.stop()` sends to acknowledge what it read covers what
  // began to be handled, never one the daemon refused. B84: it waits for the update being handled
  // to settle, refused or not, at most `HALT_REFUSAL_LIMIT_MS`, whatever microtasks, timers or I/O
  // its refusal crosses.
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (!halt.halted || method !== 'getUpdates') return prev(method, payload, signal);
    await settledWithin(halt.handling, HALT_REFUSAL_LIMIT_MS);
    const offset = (halt.started ?? 0) + (halt.refused ? 0 : 1);
    halt.acknowledged = offset;
    return prev(method, { ...payload, offset }, signal);
  });
  /**
   * B82: whether the daemon's `error` about update `updateId` leaves it for after the restart:
   * a refusal of a turn that never started, during a crash halt, before it was acknowledged.
   */
  const leftForLater = (updateId: number | undefined, error: unknown): boolean => {
    if (updateId === undefined || !halt.halted || !isTurnNotStarted(error)) return false;
    if (halt.acknowledged !== undefined && updateId < halt.acknowledged) {
      // B84: refused later than `HALT_REFUSAL_LIMIT_MS`: Telegram will not hand it over again.
      logger.warn(
        'A Telegram update the daemon refused was already acknowledged: it gets the failure reply',
        { updateId },
      );
      return false;
    }
    if (updateId === halt.started) halt.refused = true;
    return true;
  };
  const fileRoot = `${options.apiRoot ?? TELEGRAM_API_ROOT}/file/bot${options.token}`;

  /** Downloads a file on demand, through the same Bot API server (the fake one in tests). */
  const download = async (fileId: string): Promise<Uint8Array> => {
    const file = await bot.api.getFile(fileId);
    if (file.file_path === undefined) throw new Error(`Telegram gave no path for ${fileId}`);
    const response = await fetch(`${fileRoot}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  const deliver = (chatId: number, reply: TelegramReply) =>
    deliverReply(bot.api, chatId, reply, logger);

  /** `updateId`: the update it came in; an album's has none, its updates were handled. */
  const handleReceipt = async (chatId: number, receipt: PrincipalReceipt, updateId?: number) => {
    let reply: Reply | null;
    try {
      reply = await onReceipt(receipt);
    } catch (error) {
      if (leftForLater(updateId, error)) throw new NotTaken('left for after the restart');
      logger.error('The daemon failed to handle a receipt', {
        channelRef: receipt.channelRef,
        error,
      });
      reply = failed();
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

  // B82: before anything else. An update read once halted is not handled at all: it is left for
  // after the restart. One that begins before is counted, so the halt acknowledges it.
  bot.use(async (ctx, next) => {
    if (halt.halted) return;
    halt.started = ctx.update.update_id;
    halt.refused = false;
    const handling = (async () => {
      try {
        await next();
      } catch (error) {
        if (!(error instanceof NotTaken)) throw error;
        logger.info('Left a Telegram update for after the restart', {
          updateId: ctx.update.update_id,
        });
      }
    })();
    halt.handling = handling.then(
      () => {},
      () => {},
    );
    await handling;
  });

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
      await handleReceipt(
        ctx.chat.id,
        {
          images: [image],
          caption: message.caption ?? null,
          channelRef: channelRef(message.message_id),
          receivedAt: receivedAt(message),
        },
        ctx.update.update_id,
      );
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
      if (leftForLater(ctx.update.update_id, error))
        throw new NotTaken('left for after the restart');
      logger.error('The daemon failed to handle a text', {
        channelRef: channelRef(message.message_id),
        error,
      });
      reply = failed();
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
      reply = failed();
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
