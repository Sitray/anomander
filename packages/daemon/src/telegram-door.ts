import type { ButtonPress, DoorReply, PrincipalText, ReceiptHandler } from '@anomander/protocol';
import type { TelegramConfig } from './config.ts';
import type { Logger } from './processor/text-interpreter.ts';

// The Telegram front door (R-1), only while `TELEGRAM_BOT_TOKEN` and its chat ID are set:
// `@anomander/telegram` is imported then, never otherwise. Without it nothing polls Telegram and
// nothing is sent there; the desktop app's local channel is the only door, and it only answers
// (DK-4 AC5), so what the daemon would send unasked has nowhere to go.

/** What the bot hands to the daemon; the local channel calls the same handlers (DK-4 AC1). */
export interface TelegramHandlers {
  onText: (message: PrincipalText) => Promise<DoorReply | null>;
  onReceipt: ReceiptHandler;
  onButton: (press: ButtonPress) => Promise<DoorReply | null>;
}

export interface TelegramDoor {
  /** Sends to the principal's chat, unasked. Rejects without Telegram. */
  send: (message: DoorReply) => Promise<void>;
  /** Deletes a message of that chat, such as a pasted login code (R-27 AC3). */
  deleteMessage: (channelRef: string) => Promise<void>;
  /** Resolves when the bot polls for messages; at once without Telegram. */
  started: Promise<void>;
  /**
   * Settles when polling ends: resolves after `stop`, rejects when Telegram ends it (DK-2 AC2).
   * Without Telegram it resolves at `stop`.
   */
  ended: Promise<void>;
  stop(): Promise<void>;
}

export const NO_TELEGRAM = 'Telegram is not configured: nothing is sent unasked';

export interface TelegramDoorOptions {
  logger: Logger;
  /** Points the bot at another Bot API server, such as the fake one in tests. */
  apiRoot?: string | undefined;
}

export const openTelegramDoor = (
  config: TelegramConfig | undefined,
  handlers: TelegramHandlers,
  { logger, apiRoot }: TelegramDoorOptions,
): TelegramDoor => {
  if (config === undefined) {
    let stopped = (): void => {};
    const ended = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const refuse = async (): Promise<never> => {
      throw new Error(NO_TELEGRAM);
    };
    return {
      send: refuse,
      deleteMessage: refuse,
      started: Promise.resolve(),
      ended,
      stop: async () => stopped(),
    };
  }
  const { botToken, principalChatId } = config;
  const loaded = import('@anomander/telegram').then((telegram) => {
    const bot = telegram.createTelegramBot({
      token: botToken,
      principalChatId,
      ...handlers,
      logger,
      ...(apiRoot === undefined ? {} : { apiRoot }),
    });
    return {
      bot,
      send: telegram.createTelegramNotify(bot, principalChatId),
      deleteMessage: telegram.createTelegramDelete(bot, principalChatId),
    };
  });
  // `bot.start()` resolves only when polling stops; `onStart` says it polls. An `ended` nobody
  // watches must not be an unhandled rejection.
  let polls = (): void => {};
  const ended = loaded.then(({ bot }) => bot.start({ onStart: () => polls() }));
  ended.catch(() => {});
  return {
    send: async (message) => (await loaded).send(message),
    deleteMessage: async (channelRef) => (await loaded).deleteMessage(channelRef),
    started: new Promise<void>((resolve, reject) => {
      polls = resolve;
      ended.catch(reject);
    }),
    ended,
    // A bot that never loaded has nothing to stop: `ended` already says why.
    stop: () =>
      loaded.then(
        ({ bot }) => bot.stop(),
        () => {},
      ),
  };
};
