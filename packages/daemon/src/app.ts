import { type Notify, type ScreenQuestion, strings } from '@anomander/protocol';
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
  screenTurn,
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
import {
  type ChatHandlers,
  type LocalChannel,
  type LocalChannelAddress,
  startLocalChannel,
} from './local-channel/server.ts';
import { createPatternOffers } from './patterns/pattern-offers.ts';
import { createPiAiCorrectionInterpreter } from './processor/correction-interpreter.ts';
import { createPiAiReceiptReader } from './processor/receipt-reader.ts';
import { createPiAiReplyPhraser } from './processor/reply-phraser.ts';
import { withRetry } from './processor/retry.ts';
import { createPiAiScreenReader } from './processor/screen-reader.ts';
import { type Complete, createPiAiTextInterpreter } from './processor/text-interpreter.ts';
import { withTimeout } from './processor/timeout.ts';
import { type ReadApiAddress, startReadApi } from './read-api/server.ts';
import { createDueReminders } from './reminders/send-due.ts';
import { createKeepReceiptAnswerHandler } from './retention/keep-receipt-decision.ts';
import { createRetention } from './retention/retention-job.ts';
import { startScheduler } from './scheduler/scheduler.ts';
import { describeGap, type SetupGap, setupGuide } from './setup/setup-guide.ts';
import { acquireDaemonLock } from './store/daemon-lock.ts';
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
  /**
   * Settles when polling ends: resolves after `stop`, rejects when Telegram ends it, for example
   * with the 409 of another process reading the same bot (DK-2 AC2). The daemon is deaf from then
   * on, so the caller should stop it.
   */
  polling: Promise<void>;
  /**
   * Resolves with the read API's address once it listens (RA-2); `undefined` while
   * `ANOMANDER_API_TOKEN` is unset, when no port is opened at all (AC1).
   */
  readApi: Promise<ReadApiAddress> | undefined;
  /**
   * Resolves with the local channel's address once it listens (DK-3); `undefined` while
   * `ANOMANDER_LOCAL_TOKEN` is unset, when no port is opened at all.
   */
  localChannel: Promise<LocalChannelAddress> | undefined;
  stop(): Promise<void>;
}

/**
 * Runs the inputs of every front door one at a time, in the order they arrived: Telegram and the
 * desktop app are one conversation (DK-4 AC4), and two turns never interleave.
 */
const oneTurnAtATime = () => {
  let last: Promise<unknown> = Promise.resolve();
  return <I, R>(handler: (input: I) => Promise<R>) =>
    (input: I): Promise<R> => {
      const turn = last.then(() => handler(input));
      last = turn.catch(() => {});
      return turn;
    };
};

/** DK-3: the desktop app's front door, only while `ANOMANDER_LOCAL_TOKEN` is set. */
const startChannel = (
  config: Config,
  handlers: ChatHandlers,
  logger: TelegramLogger,
  now?: () => Date,
): LocalChannel | undefined =>
  config.localToken === undefined
    ? undefined
    : startLocalChannel({
        token: config.localToken,
        port: config.localPort,
        handlers,
        logger,
        ...(now === undefined ? {} : { now }),
      });

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

/**
 * `started` resolves when the bot polls for messages; `ended` settles when polling stops, since
 * `bot.start()` resolves only then. An `ended` nobody watches must not be an unhandled rejection.
 */
const polling = (bot: ReturnType<typeof createTelegramBot>) => {
  let started = (): void => {};
  const ended = bot.start({ onStart: () => started() });
  ended.catch(() => {});
  return {
    started: new Promise<void>((resolve, reject) => {
      started = resolve;
      ended.catch(reject);
    }),
    ended,
  };
};

export interface SetupGuideDeps {
  /** The model gaps `resolveModels` found: never empty. */
  gaps: readonly SetupGap[];
  login?: LoginDeps;
  telegramApiRoot?: string;
  logger?: TelegramLogger;
}

/**
 * R-28: the bot that runs while `.env` names no usable model. It answers everything with the
 * guide, except `/login` and `/logout` (R-17 AC7), in Telegram and in the desktop app's chat; no
 * processor, store, scheduled job or read API runs.
 */
export const startSetupGuide = (config: Config, deps: SetupGuideDeps): Anomander => {
  const { gaps, logger = console } = deps;
  // DK-2 AC1: no store runs here, but the daemon is still the only one of its data folder.
  const lock = acquireDaemonLock(config.dbPath);
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
  const localChannel = startChannel(
    config,
    {
      onText: async () => guide,
      onReceipt: async () => guide,
      onButton: async () => guide,
      onScreen: async () => guide,
    },
    logger,
  );

  const { started, ended } = polling(bot);
  // A failed start is the caller's to report, through `started`.
  started.then(
    () => announceGaps(gaps, send, logger),
    () => {},
  );
  return {
    started,
    polling: ended,
    readApi: undefined,
    localChannel: localChannel?.listening,
    stop: async () => {
      login?.stop();
      await localChannel?.stop();
      await bot.stop();
      lock.release();
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
  // DK-2 AC1: before the store is opened, so a second daemon leaves the ledger unchanged.
  const lock = acquireDaemonLock(config.dbPath);
  // A store that cannot be opened or migrated must not keep the lock.
  const { db, applied } = (() => {
    let opened: ReturnType<typeof openDatabase> | undefined;
    try {
      opened = openDatabase(config.dbPath);
      return { db: opened, applied: applyMigrations(opened) };
    } catch (error) {
      opened?.close();
      lock.release();
      throw error;
    }
  })();
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

  // A look at the screen: the budgeted call, so it counts against the daily cap (R-12).
  const screenReader = createPiAiScreenReader({
    complete: ai,
    model: deps.visionModel ?? model,
    logger,
  });
  const recordedScreen = recordingTurns(
    turns,
    (question: ScreenQuestion) => screenTurn(question.text),
    async (question: ScreenQuestion) => {
      const reading = await screenReader({ question: question.text, image: question.image });
      if (reading.kind === 'answer') return { text: reading.text };
      return {
        text:
          reading.kind === 'budget_exhausted'
            ? strings.textLimitReached()
            : strings.screenNotSeen(),
      };
    },
  );

  // What every front door calls (DK-4 AC1). R-28: `/start`, and the guide while a provider is
  // not connected.
  const inTurn = oneTurnAtATime();
  const chat: ChatHandlers = {
    onText: inTurn(async (message) => {
      const gaps = await setupGaps();
      if (gaps.length > 0) return { text: setupGuide(gaps) };
      return isStart(message.text) ? { text: strings.hello() } : recordedText(message);
    }),
    onReceipt: inTurn(async (receipt) => {
      const gaps = await setupGaps();
      return gaps.length > 0 ? { text: setupGuide(gaps) } : recordedReceipt(receipt);
    }),
    onButton: inTurn(async (press) => {
      const gaps = await setupGaps();
      return gaps.length > 0 ? { text: setupGuide(gaps) } : recordedButton(press);
    }),
    onScreen: inTurn(async (question) => {
      const gaps = await setupGaps();
      return gaps.length > 0 ? { text: setupGuide(gaps) } : recordedScreen(question);
    }),
  };

  const bot = createTelegramBot({
    token: config.telegramBotToken,
    principalChatId: config.principalChatId,
    // R-17 AC7: `/login`, `/logout`, their buttons and the text a running login waits for come
    // before every other route. They never reach the processor and are never recent turns. A
    // login is made in Telegram only: its messages go out through the bot.
    onText: async (message) => {
      const handled = await login?.handleText(message);
      return handled === undefined ? chat.onText(message) : handled.reply;
    },
    onReceipt: chat.onReceipt,
    onButton: async (press) => {
      const handled = await login?.handleButton(press);
      return handled === undefined ? chat.onButton(press) : handled.reply;
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

  // RA-2: the read API, only while `ANOMANDER_API_TOKEN` is set (AC1). It opens its own
  // read-only connection, after the migrations created the views it reads.
  const readApi =
    config.apiToken === undefined
      ? undefined
      : startReadApi({
          dbPath: config.dbPath,
          token: config.apiToken,
          host: config.apiHost,
          port: config.apiPort,
          logger,
        });

  const localChannel = startChannel(config, chat, logger, now);

  const { started, ended } = polling(bot);
  started.then(
    () =>
      setupGaps()
        .then((gaps) => announceGaps(gaps, send, logger))
        .catch((error: unknown) => logger.error('Could not check the setup', { error })),
    () => {},
  );

  return {
    started,
    polling: ended,
    readApi: readApi?.listening,
    localChannel: localChannel?.listening,
    stop: async () => {
      login?.stop();
      await localChannel?.stop();
      await readApi?.stop();
      await bot.stop();
      await scheduler.stop();
      db.close();
      lock.release();
    },
  };
};
