// The Telegram front door: decides who may talk (R-1) and which inputs are supported (R-20).
// What a text means is the daemon's decision, reached through `onText`.

import { strings, type TextHandler } from '@anomander/protocol';
import { Bot, type Context } from 'grammy';
import type { Message } from 'grammy/types';

export interface TelegramLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface TelegramBotOptions {
  token: string;
  /** `ANOMANDER_PRINCIPAL_CHAT_ID`: the principal's private chat ID, equal to their user ID. */
  principalChatId: number;
  onText: TextHandler;
  /** Points grammY at another Bot API server, such as the fake one in tests. */
  apiRoot?: string;
  logger?: TelegramLogger;
}

// Telegram's bot download limit (R-20).
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const channelRef = (messageId: number) => `telegram:${messageId}`;

/** What R-20 does with a message that is not text: a reply, or a receipt (M3). */
type NonTextInput = { kind: 'reply'; text: string } | { kind: 'receipt' };

const classify = (message: Message): NonTextInput => {
  const { document, photo } = message;
  if (document?.mime_type === 'application/pdf') {
    return { kind: 'reply', text: strings.pdfNotSupported() };
  }
  const isImageDocument = document?.mime_type?.startsWith('image/') === true;
  if (photo !== undefined || isImageDocument) {
    const size = Math.max(0, ...(photo ?? [document]).map((file) => file?.file_size ?? 0));
    return size > MAX_FILE_BYTES
      ? { kind: 'reply', text: strings.imageTooLarge() }
      : { kind: 'receipt' };
  }
  return { kind: 'reply', text: strings.unsupportedInput() };
};

export const createTelegramBot = (options: TelegramBotOptions): Bot => {
  const { principalChatId, onText, logger = console } = options;
  const bot = new Bot(
    options.token,
    options.apiRoot === undefined ? {} : { client: { apiRoot: options.apiRoot } },
  );

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
      } else {
        // Receipts are M3 (assumption A2).
        logger.info('Ignored a receipt image until receipts are supported', {
          chatId: ctx.chat.id,
          messageId: message.message_id,
        });
      }
      return;
    }

    let reply: Awaited<ReturnType<TextHandler>>;
    try {
      reply = await onText({
        text: message.text,
        channelRef: channelRef(message.message_id),
        receivedAt: new Date(message.date * 1000).toISOString(),
      });
    } catch (error) {
      logger.error('The daemon failed to handle a text', {
        channelRef: channelRef(message.message_id),
        error,
      });
      return;
    }
    const sent = await ctx.api.sendMessage(ctx.chat.id, reply.text);
    reply.onDelivered?.({
      channelRef: channelRef(sent.message_id),
      deliveredAt: new Date().toISOString(),
    });
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
