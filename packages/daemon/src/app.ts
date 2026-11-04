import { type Notify, strings } from '@anomander/protocol';
import {
  createTelegramBot,
  createTelegramDelete,
  createTelegramNotify,
  type TelegramLogger,
  type TelegramReply,
} from '@anomander/telegram';
import { createTelegramLogin, type TelegramLoginDeps } from './auth/telegram-login.ts';
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
import { createCancelReminderAnswerHandler } from './decisions/cancel-reminder-decision.ts';
import { createExpenseCorrection } from './decisions/correction.ts';
import { createCreateCategoryAnswerHandler } from './decisions/create-category-decision.ts';
import { createCreatePolicyAnswerHandler } from './decisions/create-policy-decision.ts';
import { createForgetMemoryAnswerHandler } from './decisions/forget-memory-decision.ts';
import { createGrantDigestAnswerHandler } from './decisions/grant-digest-decision.ts';
import { createGrantWeeklySummaryAnswerHandler } from './decisions/grant-weekly-summary-decision.ts';
import { createTextRouter } from './decisions/router.ts';
import { createMorningDigest } from './digest/send-digest.ts';
import { createReceiptExpenseCycle } from './expenses/receipt-expense.ts';
import { createTextExpenseHandler } from './expenses/text-expense.ts';
import { createPatternOffers } from './patterns/pattern-offers.ts';
import { createPiAiCorrectionInterpreter } from './processor/correction-interpreter.ts';
import { createPiAiReceiptReader } from './processor/receipt-reader.ts';
import { createPiAiReplyPhraser } from './processor/reply-phraser.ts';
import { withRetry } from './processor/retry.ts';
import { type Complete, createPiAiTextInterpreter } from './processor/text-interpreter.ts';
import { withTimeout } from './processor/timeout.ts';
import { createDueReminders } from './reminders/send-due.ts';
import { createKeepReceiptAnswerHandler } from './retention/keep-receipt-decision.ts';
import { createRetention } from './retention/retention-job.ts';
import { startScheduler } from './scheduler/scheduler.ts';
import { describeGap, type SetupGap, setupGuide } from './setup/setup-guide.ts';
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
  /**
   * Model login from Telegram (R-27): pi-ai's `models`, the credential store it uses and the
   * device ID. `main.ts` always passes it; tests that leave it out get no `/login` or `/logout`.
   */
  login?: LoginDeps;
  /**
   * The connection gaps, checked on every message (R-28 AC4). `main.ts` passes pi-ai's
   * `checkAuth` for both models' providers; without it, setup is always complete.
   */
  setupGaps?: () => Promise<readonly SetupGap[]>;
  /** Points the bot at another Bot API server, such as the fake one in tests. */
  telegramApiRoot?: string;
  logger?: TelegramLogger;
  now?: () => Date;
}

type LoginDeps = Pick<TelegramLoginDeps, 'models' | 'credentials' | 'getDeviceId' | 'timeoutMs'>;

export interface Anomander {
  /** Resolves when the store is ready and the bot polls for messages. */
  started: Promise<void>;
  stop(): Promise<void>;
}

/** `/start`, `/start@bot` or `/start anything`, as Telegram sends a command. */
const isStart = (text: string) => /^\/start(?:@\w+)?(?:\s|$)/.test(text.trim());

/** Logs the gaps in English and sends the guide, once the bot listens (R-28 AC3). */
const announceGaps = async (
  gaps: readonly SetupGap[],
  send: (message: TelegramReply) => Promise<void>,
  logger: TelegramLogger,
): Promise<void> => {
  if (gaps.length === 0) return;
  for (const gap of gaps) logger.warn(`setup incomplete: ${describeGap(gap)}`);
  await send({ text: setupGuide(gaps) }).catch((error: unknown) => {
    logger.error('Could not send the setup guide', { error });
  });
};

/** Resolves when the bot polls for messages; `bot.start()` resolves only when polling stops. */
const polling = (bot: ReturnType<typeof createTelegramBot>) =>
  new Promise<void>((resolve, reject) => {
    bot.start({ onStart: () => resolve() }).catch(reject);
  });

export interface SetupGuideDeps {
  /** The model gaps `resolveModels` found: never empty. */
  gaps: readonly SetupGap[];
  login?: LoginDeps;
  telegramApiRoot?: string;
  logger?: TelegramLogger;
}

/**
 * R-28: the bot that runs while `.env` names no usable model. It answers everything with the
 * guide, except `/login` and `/logout` (R-17 AC7); no processor, store or scheduled job runs.
 */
export const startSetupGuide = (config: Config, deps: SetupGuideDeps): Anomander => {
  const { gaps, logger = console } = deps;
  const guide = { text: setupGuide(gaps) };
  let send = async (_: TelegramReply): Promise<void> => {
    throw new Error('send used before the bot was created');
  };
  let deleteMessage = async (_: string): Promise<void> => {
    throw new Error('deleteMessage used before the bot was created');
  };
  const login =
    deps.login === undefined
      ? undefined
      : createTelegramLogin({
          ...deps.login,
          send: (message) => send(message),
          deleteMessage: (channelRef) => deleteMessage(channelRef),
          logger,
        });
  const bot = createTelegramBot({
    token: config.telegramBotToken,
    principalChatId: config.principalChatId,
    onText: async (message) => {
      const handled = await login?.handleText(message);
      return handled === undefined ? guide : handled.reply;
    },
    onReceipt: async () => guide,
    onButton: async (press) => {
      const handled = await login?.handleButton(press);
      return handled === undefined ? guide : handled.reply;
    },
    logger,
    ...(deps.telegramApiRoot === undefined ? {} : { apiRoot: deps.telegramApiRoot }),
  });
  send = createTelegramNotify(bot, config.principalChatId);
  deleteMessage = createTelegramDelete(bot, config.principalChatId);

  const started = polling(bot);
  // A failed start is the caller's to report, through `started`.
  started.then(
    () => announceGaps(gaps, send, logger),
    () => {},
  );
  return {
    started,
    stop: async () => {
      login?.stop();
      await bot.stop();
    },
  };
};

export const startAnomander = <M>(config: Config, deps: AnomanderDeps<M>): Anomander => {
  const { complete, model, logger = console, now = () => new Date() } = deps;
  const textModel = config.model;
  const visionModel = config.visionModel;
  if (textModel === undefined || visionModel === undefined) {
    throw new Error('both models must be set; without them, start the setup guide (R-28)');
  }
  const setupGaps = deps.setupGaps ?? (async () => []);
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
  // R-22 AC2, AC3: each attempt has its own timeout; each retry counts against the budget.
  const timed = withRetry(withTimeout(complete, config.processorTimeoutMs), {
    mayRetry: () => budget.tryConsume(),
    logger,
  });
  const ai = budgeted(timed, budget);

  const phraser = createPiAiReplyPhraser({ complete: ai, model, logger });
  // R-16 AC3: every exchange with the principal is a recent turn, kept only in memory.
  const turns = createRecentTurns({ now });
  // R-13 AC2: S-12 goes out unasked through `notify`, which needs the bot, while the bot needs the
  // handlers that offer it; it is bound below, before the bot starts polling.
  let notify: Notify = async () => {
    throw new Error('notify used before the bot was created');
  };
  const patterns = createPatternOffers({ db, now, logger, notify: (message) => notify(message) });
  const onText = createTextRouter({
    db,
    corrections: {
      register_expense: createExpenseCorrection({
        db,
        interpreter: createPiAiCorrectionInterpreter({ complete: ai, model, logger }),
        timeZone: config.timeZone,
        now,
        logger,
        patterns,
      }),
    },
    otherwise: createTextExpenseHandler({
      db,
      interpreter: createPiAiTextInterpreter({ complete: ai, model, logger }),
      phraser,
      timeZone: config.timeZone,
      now,
      processorSource: `processor:${textModel.provider}/${textModel.id}`,
      logger,
      recent: turns.recent,
      patterns,
    }),
    now,
  });
  const vision = deps.visionModel === undefined ? textModel : visionModel;
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
      ...createDecisionAnswers({ phraser, logger, patterns }),
      keep_receipt: createKeepReceiptAnswerHandler({ timeZone: config.timeZone }),
      // R-16 AC3: a confirmed forget empties the recent turns.
      forget_memory: createForgetMemoryAnswerHandler({ clearRecentTurns: turns.clear }),
      // R-18 AC1, AC3: "Sí" to S-15 creates the category.
      create_category: createCreateCategoryAnswerHandler({ logger }),
      // R-13 AC1, AC2: "Sí" to S-11 or S-12 stores the policy.
      create_policy: createCreatePolicyAnswerHandler(),
      // R-25 AC9: "Sí" to S-46 cancels the reminders and tasks it named.
      cancel_reminder: createCancelReminderAnswerHandler(),
      // R-26 AC2: "Sí" to S-53 grants the morning digest's permission.
      grant_morning_digest: createGrantDigestAnswerHandler(),
      // R-10 AC6: "Sí" to S-74 grants the weekly summary's permission.
      grant_weekly_summary: createGrantWeeklySummaryAnswerHandler(),
    },
    now,
    logger,
  });

  // R-27: a login's messages go straight to the bot, never through `recordingNotices`. Like
  // `notify`, both are bound below, once the bot exists.
  let send = async (_: TelegramReply): Promise<void> => {
    throw new Error('send used before the bot was created');
  };
  let deleteMessage = async (_: string): Promise<void> => {
    throw new Error('deleteMessage used before the bot was created');
  };
  const login =
    deps.login === undefined
      ? undefined
      : createTelegramLogin({
          ...deps.login,
          send: (message) => send(message),
          deleteMessage: (channelRef) => deleteMessage(channelRef),
          logger,
        });
  const recordedText = recordingTurns(turns, (message) => message.text, onText);
  const recordedButton = recordingTurns(
    turns,
    (press) => buttonTurn(pressedOption(db, press.data)),
    onButton,
  );
  const recordedReceipt = recordingTurns(
    turns,
    (receipt) => receiptTurn(receipt.caption),
    receipts.onReceipt,
  );

  const bot = createTelegramBot({
    token: config.telegramBotToken,
    principalChatId: config.principalChatId,
    // R-17 AC7: `/login`, `/logout`, their buttons and the text a running login waits for come
    // before every other route. They never reach the processor and are never recent turns.
    // R-28: then `/start`, and the guide while a provider is not connected.
    onText: async (message) => {
      const handled = await login?.handleText(message);
      if (handled !== undefined) return handled.reply;
      const gaps = await setupGaps();
      if (gaps.length > 0) return { text: setupGuide(gaps) };
      return isStart(message.text) ? { text: strings.hello() } : recordedText(message);
    },
    onReceipt: async (receipt) => {
      const gaps = await setupGaps();
      return gaps.length > 0 ? { text: setupGuide(gaps) } : recordedReceipt(receipt);
    },
    onButton: async (press) => {
      const handled = await login?.handleButton(press);
      if (handled !== undefined) return handled.reply;
      const gaps = await setupGaps();
      return gaps.length > 0 ? { text: setupGuide(gaps) } : recordedButton(press);
    },
    logger,
    ...(deps.telegramApiRoot === undefined ? {} : { apiRoot: deps.telegramApiRoot }),
  });

  // R-8, R-10, R-12 AC3, R-13 AC2, R-19, R-25 AC7 and R-26 AC5 send messages the principal did
  // not ask for.
  notify = recordingNotices(turns, createTelegramNotify(bot, config.principalChatId));
  send = createTelegramNotify(bot, config.principalChatId);
  deleteMessage = createTelegramDelete(bot, config.principalChatId);
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
  const dueReminders = createDueReminders({ db, timeZone: config.timeZone, now, notify, logger });
  const digest = createMorningDigest({ db, timeZone: config.timeZone, now, notify, logger });
  const scheduler = startScheduler({
    retentionCron: config.retentionCron,
    weeklySummaryCron: config.weeklySummaryCron,
    timeZone: config.timeZone,
    jobs: {
      retain: retention.retain,
      sendMorningDigest: digest.send,
      sendDueReminders: dueReminders.send,
      drainQueue: queue.drain,
      watchReceipts: retention.watchQueuedReceipts,
      sendWeeklySummary: summary.send,
    },
    logger,
  });

  const started = polling(bot);
  started.then(
    () =>
      setupGaps()
        .then((gaps) => announceGaps(gaps, send, logger))
        .catch((error: unknown) => logger.error('Could not check the setup', { error })),
    () => {},
  );

  return {
    started,
    stop: async () => {
      login?.stop();
      await bot.stop();
      await scheduler.stop();
      db.close();
    },
  };
};
