import { createTelegramBot, createTelegramNotify, type TelegramLogger } from '@anomander/telegram';
import { budgeted, createAiBudget } from './budget/ai-budget.ts';
import { createReceiptQueue } from './budget/receipt-queue.ts';
import type { Config } from './config.ts';
import {
  buttonTurn,
  createRecentTurns,
  receiptTurn,
  recordingNotices,
  recordingTurns,
} from './conversation/recent-turns.ts';
import { createButtonHandler, createDecisionAnswers, pressedOption } from './decisions/answer.ts';
import { createExpenseCorrection } from './decisions/correction.ts';
import { createCreateCategoryAnswerHandler } from './decisions/create-category-decision.ts';
import { createForgetMemoryAnswerHandler } from './decisions/forget-memory-decision.ts';
import { createTextRouter } from './decisions/router.ts';
import { createReceiptExpenseCycle } from './expenses/receipt-expense.ts';
import { createTextExpenseHandler } from './expenses/text-expense.ts';
import { createPiAiCorrectionInterpreter } from './processor/correction-interpreter.ts';
import { createPiAiReceiptReader } from './processor/receipt-reader.ts';
import { createPiAiReplyPhraser } from './processor/reply-phraser.ts';
import { type Complete, createPiAiTextInterpreter } from './processor/text-interpreter.ts';
import { withTimeout } from './processor/timeout.ts';
import { createKeepReceiptAnswerHandler } from './retention/keep-receipt-decision.ts';
import { createRetention } from './retention/retention-job.ts';
import { startScheduler } from './scheduler/scheduler.ts';
import { applyMigrations, openDatabase } from './store/database.ts';
import { createWeeklySummary } from './summary/weekly-summary.ts';

// The composition root: one process, one SQLite file, the Telegram front door in the same
// process (PRD §14.3). `main.ts` passes pi-ai's `models.complete`; the e2e test passes recorded
// responses and the fake Telegram API.

export interface AnomanderDeps<M> {
  /** The processor call: pi-ai's `models.complete` (R-14 AC3). It must honour `signal`. */
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

  // R-12: every processor call counts against the daily cap. A receipt reserves its reader call
  // before reading, so the reader gets the raw call (see `ReceiptExpenseDeps.budget`).
  const budget = createAiBudget({
    db,
    limit: config.dailyAiCallLimit,
    timeZone: config.timeZone,
    now,
  });
  const timed = withTimeout(complete, config.processorTimeoutMs);
  const ai = budgeted(timed, budget);

  const phraser = createPiAiReplyPhraser({ complete: ai, model, logger });
  // R-16 AC3: every exchange with the principal is a recent turn, kept only in memory.
  const turns = createRecentTurns({ now });
  const onText = createTextRouter({
    db,
    corrections: {
      register_expense: createExpenseCorrection({
        db,
        interpreter: createPiAiCorrectionInterpreter({ complete: ai, model, logger }),
        timeZone: config.timeZone,
        now,
        logger,
      }),
    },
    otherwise: createTextExpenseHandler({
      db,
      interpreter: createPiAiTextInterpreter({ complete: ai, model, logger }),
      phraser,
      timeZone: config.timeZone,
      now,
      processorSource: `processor:${config.model.provider}/${config.model.id}`,
      logger,
      recent: turns.recent,
    }),
    now,
  });
  const vision = deps.visionModel === undefined ? config.model : config.visionModel;
  const receipts = createReceiptExpenseCycle({
    db,
    reader: createPiAiReceiptReader({ complete: timed, model: deps.visionModel ?? model, logger }),
    phraser,
    inboxDir: config.inboxDir,
    timeZone: config.timeZone,
    now,
    processorSource: `processor:${vision.provider}/${vision.id}`,
    logger,
    budget,
  });
  const onButton = createButtonHandler({
    db,
    answers: {
      ...createDecisionAnswers({ phraser, logger }),
      keep_receipt: createKeepReceiptAnswerHandler({ timeZone: config.timeZone }),
      // R-16 AC3: a confirmed forget empties the recent turns.
      forget_memory: createForgetMemoryAnswerHandler({ clearRecentTurns: turns.clear }),
      // R-18 AC1, AC3: "Sí" to S-15 creates the category.
      create_category: createCreateCategoryAnswerHandler({ logger }),
    },
    now,
    logger,
  });

  const bot = createTelegramBot({
    token: config.telegramBotToken,
    principalChatId: config.principalChatId,
    onText: recordingTurns(turns, (message) => message.text, onText),
    onReceipt: recordingTurns(turns, (receipt) => receiptTurn(receipt.caption), receipts.onReceipt),
    onButton: recordingTurns(turns, (press) => buttonTurn(pressedOption(db, press.data)), onButton),
    logger,
    ...(deps.telegramApiRoot === undefined ? {} : { apiRoot: deps.telegramApiRoot }),
  });

  // R-8, R-10, R-12 AC3 and R-19 run without a message: their replies go to the principal unasked.
  const notify = recordingNotices(turns, createTelegramNotify(bot, config.principalChatId));
  const retention = createRetention({
    db,
    inboxDir: config.inboxDir,
    timeZone: config.timeZone,
    now,
    notify,
    logger,
  });
  const summary = createWeeklySummary({ db, timeZone: config.timeZone, now, notify });
  const queue = createReceiptQueue({ db, readQueued: receipts.readQueued, notify, now, logger });
  const scheduler = startScheduler({
    retentionCron: config.retentionCron,
    weeklySummaryCron: config.weeklySummaryCron,
    timeZone: config.timeZone,
    jobs: {
      retain: retention.retain,
      drainQueue: queue.drain,
      watchReceipts: retention.watchQueuedReceipts,
      sendWeeklySummary: summary.send,
    },
    logger,
  });

  // `bot.start()` resolves only when polling stops; `onStart` marks the bot as listening.
  const started = new Promise<void>((resolve, reject) => {
    bot.start({ onStart: () => resolve() }).catch(reject);
  });

  return {
    started,
    stop: async () => {
      await bot.stop();
      await scheduler.stop();
      db.close();
    },
  };
};
