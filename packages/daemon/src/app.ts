import { createTelegramBot, type TelegramLogger } from '@anomander/telegram';
import type { Config } from './config.ts';
import { createReceiptExpenseHandler } from './expenses/receipt-expense.ts';
import { createTextExpenseHandler } from './expenses/text-expense.ts';
import { createPiAiReceiptReader } from './processor/receipt-reader.ts';
import { createPiAiReplyPhraser } from './processor/reply-phraser.ts';
import { type Complete, createPiAiTextInterpreter } from './processor/text-interpreter.ts';
import { applyMigrations, openDatabase } from './store/database.ts';

// The composition root: one process, one SQLite file, the Telegram front door in the same
// process (PRD §14.3). `main.ts` passes pi-ai's `models.complete`; the e2e test passes recorded
// responses and the fake Telegram API.

export interface AnomanderDeps<M> {
  /** The processor call: pi-ai's `models.complete` (R-14 AC3). */
  complete: Complete<M>;
  /** `ANOMANDER_MODEL`, resolved by the caller (R-15 AC1). */
  model: M;
  /**
   * `ANOMANDER_VISION_MODEL`, resolved by the caller (R-15 AC1), for reading receipts. Without
   * it, receipts are read with `model`.
   */
  visionModel?: M;
  /** Points the bot at another Bot API server, such as the fake one in tests. */
  telegramApiRoot?: string;
  logger?: TelegramLogger;
  now?: () => Date;
}

export interface Anomander {
  /** Resolves when the store is ready and the bot polls for messages. */
  started: Promise<void>;
  stop(): Promise<void>;
}

export const startAnomander = <M>(config: Config, deps: AnomanderDeps<M>): Anomander => {
  const { complete, model, logger = console, now = () => new Date() } = deps;
  const db = openDatabase(config.dbPath);
  const applied = applyMigrations(db);
  logger.info(`anomander store ready at ${config.dbPath} (${applied} migrations applied)`);

  const phraser = createPiAiReplyPhraser({ complete, model, logger });
  const onText = createTextExpenseHandler({
    db,
    interpreter: createPiAiTextInterpreter({ complete, model, logger }),
    phraser,
    timeZone: config.timeZone,
    now,
    processorSource: `processor:${config.model.provider}/${config.model.id}`,
    logger,
  });
  const vision = deps.visionModel === undefined ? config.model : config.visionModel;
  const onReceipt = createReceiptExpenseHandler({
    db,
    reader: createPiAiReceiptReader({ complete, model: deps.visionModel ?? model, logger }),
    phraser,
    inboxDir: config.inboxDir,
    timeZone: config.timeZone,
    now,
    processorSource: `processor:${vision.provider}/${vision.id}`,
    logger,
  });

  const bot = createTelegramBot({
    token: config.telegramBotToken,
    principalChatId: config.principalChatId,
    onText,
    onReceipt,
    logger,
    ...(deps.telegramApiRoot === undefined ? {} : { apiRoot: deps.telegramApiRoot }),
  });

  // `bot.start()` resolves only when polling stops; `onStart` marks the bot as listening.
  const started = new Promise<void>((resolve, reject) => {
    bot.start({ onStart: () => resolve() }).catch(reject);
  });

  return {
    started,
    stop: async () => {
      await bot.stop();
      db.close();
    },
  };
};
