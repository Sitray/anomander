import { basename, dirname } from 'node:path';
import {
  type ButtonPress,
  type ComputerRequest,
  type DoorReply,
  MAX_COMPUTER_STEPS,
  type Notify,
  type PrincipalText,
  type ProbeOutcome,
  ROUTE_KINDS,
  type RouteKind,
  type ScreenQuestion,
  setLocale,
  strings,
} from '@anomander/protocol';
import { createTelegramLogin, type TelegramLoginDeps } from './auth/telegram-login.ts';
import { createDailyBackup } from './backup/daily-backup.ts';
import { budgeted, createAiBudget } from './budget/ai-budget.ts';
import { createReceiptQueue } from './budget/receipt-queue.ts';
import type { Config } from './config.ts';
import { readConnections } from './connections/config.ts';
import type { Connection } from './connections/connection.ts';
import { createConnections } from './connections/mcp-client.ts';
import { type OAuthSet, oauthKeeperFrom, printOAuthForShell } from './connections/oauth.ts';
import { createConnectionSession, type Door, type Later } from './connections/session.ts';
import { type ConnectionProblems, createConnectionTasks } from './connections/task.ts';
import {
  buttonTurn,
  computerTurn,
  createRecentTurns,
  receiptTurn,
  recordingNotices,
  recordingTurns,
  screenTurn,
} from './conversation/recent-turns.ts';
import { createButtonHandler, createDecisionAnswers, pressedOption } from './decisions/answer.ts';
import { createCancelReminderAnswerHandler } from './decisions/cancel-reminder-decision.ts';
import { createAmendExpenseCorrection, createExpenseCorrection } from './decisions/correction.ts';
import { createCreateCategoryAnswerHandler } from './decisions/create-category-decision.ts';
import { createCreatePolicyAnswerHandler } from './decisions/create-policy-decision.ts';
import { createForgetHistoryAnswerHandler } from './decisions/forget-history-decision.ts';
import { createForgetMemoryAnswerHandler } from './decisions/forget-memory-decision.ts';
import { createGrantDigestAnswerHandler } from './decisions/grant-digest-decision.ts';
import { createGrantWeeklySummaryAnswerHandler } from './decisions/grant-weekly-summary-decision.ts';
import { createTextRouter } from './decisions/router.ts';
import { type RowOption, rowButton, rowLabel } from './decisions/window-amend.ts';
import { createMorningDigest } from './digest/send-digest.ts';
import { createReceiptExpenseCycle } from './expenses/receipt-expense.ts';
import { createTextExpenseHandler } from './expenses/text-expense.ts';
import {
  type ChatHandlers,
  type ConnectionGrants,
  type ExpensesLedger,
  type LocalChannel,
  type LocalChannelAddress,
  type StoredConversation,
  type StoredMemory,
  startLocalChannel,
} from './local-channel/server.ts';
import { createPatternOffers } from './patterns/pattern-offers.ts';
import { createPiAiComputerPlanner } from './processor/computer-planner.ts';
import { createPiAiCorrectionInterpreter } from './processor/correction-interpreter.ts';
import type { Complete, Logger } from './processor/ports.ts';
import { createPiAiReceiptReader } from './processor/receipt-reader.ts';
import { createPiAiReplyPhraser } from './processor/reply-phraser.ts';
import { withRetry } from './processor/retry.ts';
import { createPiAiScreenReader } from './processor/screen-reader.ts';
import { createPiAiTextInterpreter } from './processor/text-interpreter.ts';
import { withTimeout } from './processor/timeout.ts';
import { readExpensesMonth } from './read-api/month.ts';
import { type ReadApiAddress, startReadApi } from './read-api/server.ts';
import { createDueReminders } from './reminders/send-due.ts';
import { createKeepReceiptAnswerHandler } from './retention/keep-receipt-decision.ts';
import { createRetention } from './retention/retention-job.ts';
import { groundedRoutes } from './routing/grounded-route.ts';
import { startScheduler } from './scheduler/scheduler.ts';
import { createModelProbe, probeWithoutModel } from './setup/model-probe.ts';
import {
  appSetupGuide,
  cachedSetupGaps,
  describeGap,
  type SetupGap,
  setupGuide,
} from './setup/setup-guide.ts';
import { storedConversation } from './store/conversation.ts';
import { acquireDaemonLock } from './store/daemon-lock.ts';
import { applyMigrations, openDatabase } from './store/database.ts';
import { exportLedger } from './store/export.ts';
import { type ActionRecord, forgetAction, listActions, recordAction } from './store/history.ts';
import { forgetMemoryAndItsTurns, listMemories, memoryNotesFor } from './store/memory.ts';
import {
  connectionToolGranted,
  connectionToolGrants,
  grantConnectionTool,
  revokeConnectionTool,
  revokeConnectionToolsNotIn,
} from './store/permissions.ts';
import { createWeeklySummary } from './summary/weekly-summary.ts';
import { openTelegramDoor } from './telegram-door.ts';

// The composition root: one process, one SQLite file, the front doors in the same process (PRD
// §14.3): Telegram while it is configured, the desktop app's local channel while
// `ANOMANDER_LOCAL_TOKEN` is set, at least one of them (`loadConfig`). `main.ts` passes pi-ai's
// `models.complete`; the e2e test passes recorded responses and the fake Telegram API.

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
   * device ID. `main.ts` always passes it; tests that leave it out, and a daemon without
   * Telegram, get no `/login` or `/logout`.
   */
  login?: LoginDeps;
  /**
   * The connection gaps, checked on every message (R-28 AC4) before its turn, through
   * `cachedSetupGaps`. `main.ts` passes pi-ai's `checkAuth` for both models' providers; without
   * it, setup is always complete.
   */
  setupGaps?: () => Promise<readonly SetupGap[]>;
  /** How long `stop` waits for the turns that run before it closes the store; 5 s by default. */
  shutdownDeadlineMs?: number;
  /** Points the bot at another Bot API server, such as the fake one in tests. */
  telegramApiRoot?: string;
  /**
   * The servers connected now (DK-11). Without it they are the ones of `ANOMANDER_MCP_CONFIG`,
   * connected when a task first needs them; tests pass their own.
   */
  connections?: () => Promise<readonly Connection[]>;
  /** What is known about the servers that are not connected; goes with `connections`. */
  connectionProblems?: () => ConnectionProblems;
  /** Hands the OAuth tokens a refresh changed to the shell; tests catch them. */
  printOAuth?: (entries: OAuthSet) => void;
  logger?: Logger;
  now?: () => Date;
}

type LoginDeps = Pick<TelegramLoginDeps, 'models' | 'credentials' | 'getDeviceId' | 'timeoutMs'>;

export interface Anomander {
  /** Resolves when the store is ready and the bot, if there is one, polls for messages. */
  started: Promise<void>;
  /**
   * Settles when polling ends: resolves after `stop`, rejects when Telegram ends it, for example
   * with the 409 of another process reading the same bot (DK-2 AC2). The daemon is deaf to
   * Telegram from then on, so the caller should stop it. Without Telegram it resolves at `stop`.
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

/** T14: how long a shutdown waits for the turns that run before it closes the store. */
export const SHUTDOWN_DEADLINE_MS = 5_000;
const STOPPING = 'ANOMANDER is stopping: this turn did not start';

/**
 * Runs the inputs of every front door one at a time, in the order they arrived: Telegram and the
 * desktop app are one conversation (DK-4 AC4), and two turns never interleave. Once `close` is
 * called no turn starts, except one that ends work already running (`ends`); `drained` settles
 * when every turn and every piece of work given to `track` has.
 */
const oneTurnAtATime = () => {
  let last: Promise<unknown> = Promise.resolve();
  let closed = false;
  const running = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    running.add(work);
    const done = () => running.delete(work);
    work.then(done, done);
    return work;
  };
  const inTurn =
    <I, R>(handler: (input: I) => Promise<R>, { ends = false } = {}) =>
    (input: I): Promise<R> => {
      const turn = last.then(() => {
        if (closed && !ends) throw new Error(STOPPING);
        return handler(input);
      });
      last = turn.catch(() => {});
      return track(turn);
    };
  return {
    inTurn,
    track,
    close: () => {
      closed = true;
    },
    // Work may start more work, such as a turn that starts a task's step: wait until none is left.
    drained: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
};

/** Whether `work` settled within `ms`. */
const settlesWithin = async (work: Promise<unknown>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
};

/** DK-3: the desktop app's front door, only while `ANOMANDER_LOCAL_TOKEN` is set. */
const startChannel = (
  config: Config,
  handlers: ChatHandlers,
  conversation: StoredConversation,
  memory: StoredMemory,
  expenses: ExpensesLedger,
  logger: Logger,
  now?: () => Date,
  grants?: ConnectionGrants,
  /** DK-23 AC4: "Probar". */
  probe?: () => Promise<ProbeOutcome>,
): LocalChannel | undefined =>
  config.localToken === undefined
    ? undefined
    : startLocalChannel({
        token: config.localToken,
        port: config.localPort,
        handlers,
        conversation,
        memory,
        expenses,
        logger,
        ...(now === undefined ? {} : { now }),
        ...(grants === undefined ? {} : { grants }),
        ...(probe === undefined ? {} : { probe }),
      });

/** `/start`, `/start@bot` or `/start anything`, as Telegram sends a command. */
const isStart = (text: string) => /^\/start(?:@\w+)?(?:\s|$)/.test(text.trim());

/** The task of `/mcp <tarea>` or `/mcp@bot <tarea>`, empty without one; `undefined` otherwise. */
const connectionCommand = (text: string): string | undefined => {
  const command = /^\/mcp(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return command === null ? undefined : (command[1] ?? '').trim();
};

/** R-29: `/exportar` or `/exportar@bot`, with anything after it. */
const isExport = (text: string) => /^\/exportar(?:@\w+)?(?:\s|$)/.test(text.trim());

/** The front door a message came through: the local channel names its messages `desktop:…`. */
const doorOf = (channelRef: string): Door =>
  channelRef.startsWith('desktop:') ? 'app' : 'telegram';

/**
 * DK-13 AC1: a look and a task on the computer need the app; connections serve both doors.
 * DK-20: on Windows the app has neither yet, so it offers only connections, as Telegram does.
 */
const routesOf = (door: Door): readonly RouteKind[] =>
  door === 'app' && process.platform !== 'win32' ? ROUTE_KINDS : ['connect'];

/** What a handler answers once its turn is over: a `Later` is waited for outside the turn. */
const settled = async (answer: DoorReply | Later | null): Promise<DoorReply | null> =>
  answer !== null && 'later' in answer ? answer.later : answer;

/**
 * Logs the gaps in English and sends the guide, once the bot listens (R-28 AC3). Without
 * Telegram nothing is sent: the app's chat answers every message with the guide anyway.
 */
const announceGaps = async (
  gaps: readonly SetupGap[],
  send: ((message: DoorReply) => Promise<void>) | undefined,
  logger: Logger,
): Promise<void> => {
  if (gaps.length === 0) return;
  for (const gap of gaps) logger.warn(`setup incomplete: ${describeGap(gap)}`);
  await send?.({ text: setupGuide(gaps) }).catch((error: unknown) => {
    logger.error('Could not send the setup guide', { error });
  });
};

export interface SetupGuideDeps {
  /** The model gaps `resolveModels` found: never empty. */
  gaps: readonly SetupGap[];
  login?: LoginDeps;
  telegramApiRoot?: string;
  logger?: Logger;
}

/**
 * R-28: the bot that runs while `.env` names no usable model. It answers everything with the
 * guide, except `/login` and `/logout` (R-17 AC7), in Telegram and in the desktop app's chat; no
 * processor, store, scheduled job or read API runs.
 */
export const startSetupGuide = (config: Config, deps: SetupGuideDeps): Anomander => {
  // Before any text is built: the guide below is written once, in this language.
  setLocale(config.locale);
  const { gaps, logger = console } = deps;
  // DK-2 AC1: no store runs here, but the daemon is still the only one of its data folder.
  const lock = acquireDaemonLock(config.dbPath);
  const guide = { text: setupGuide(gaps) };
  // DK-23 AC5: the app's chat gets the guide about its window.
  const appGuide = { text: appSetupGuide(gaps) };
  let send = async (_: DoorReply): Promise<void> => {
    throw new Error('send used before the bot was created');
  };
  let deleteMessage = async (_: string): Promise<void> => {
    throw new Error('deleteMessage used before the bot was created');
  };
  // R-27: a login is made in Telegram only; the app has its Suscripciones screen (DK-15).
  const login =
    deps.login === undefined || config.telegram === undefined
      ? undefined
      : createTelegramLogin({
          ...deps.login,
          send: (message) => send(message),
          deleteMessage: (channelRef) => deleteMessage(channelRef),
          logger,
        });
  const telegram = openTelegramDoor(
    config.telegram,
    {
      onText: async (message) => {
        const handled = await login?.handleText(message);
        return handled === undefined ? guide : handled.reply;
      },
      onReceipt: async () => guide,
      onButton: async (press) => {
        const handled = await login?.handleButton(press);
        return handled === undefined ? guide : handled.reply;
      },
    },
    { logger, apiRoot: deps.telegramApiRoot },
  );
  send = telegram.send;
  deleteMessage = telegram.deleteMessage;
  const localChannel = startChannel(
    config,
    {
      // R-17 AC7: a code pasted in the app's chat while a login waits goes to it, never stored.
      onText: async (message) => (login?.takePasted(message.text) === true ? null : appGuide),
      onReceipt: async () => appGuide,
      onButton: async () => appGuide,
      onScreen: async () => appGuide,
      onComputer: async () => appGuide,
      onConnect: async () => appGuide,
    },
    // No store runs here: the app's chat starts empty, and an erase cannot be done yet.
    {
      messages: () => [],
      clear: () => {
        throw new Error('the setup guide opens no database');
      },
    },
    {
      memories: () => [],
      actions: () => [],
      forgetMemory: () => {
        throw new Error('the setup guide opens no database');
      },
      forgetAction: () => {
        throw new Error('the setup guide opens no database');
      },
    },
    // DK-17: nor can expenses be read or changed: the window says it could not (S-22).
    {
      month: () => {
        throw new Error('the setup guide opens no database');
      },
      undo: () => {
        throw new Error('the setup guide opens no database');
      },
      correct: () => {
        throw new Error('the setup guide opens no database');
      },
    },
    logger,
    undefined,
    // DK-24: the setup guide holds no grants.
    undefined,
    // DK-23 AC4: no model can be called; the probe says why.
    async () => probeWithoutModel(gaps, config),
  );

  // A failed start is the caller's to report, through `started`.
  telegram.started.then(
    () => announceGaps(gaps, config.telegram === undefined ? undefined : send, logger),
    () => {},
  );
  return {
    started: telegram.started,
    polling: telegram.ended,
    readApi: undefined,
    localChannel: localChannel?.listening,
    stop: async () => {
      login?.stop();
      await localChannel?.stop();
      await telegram.stop();
      lock.release();
    },
  };
};

export const startAnomander = <M>(config: Config, deps: AnomanderDeps<M>): Anomander => {
  // Before any text is built: one daemon speaks one language for its whole life.
  setLocale(config.locale);
  const { complete, model, logger = console, now = () => new Date() } = deps;
  const textModel = config.model;
  const visionModel = config.visionModel;
  if (textModel === undefined || visionModel === undefined) {
    throw new Error('both models must be set; without them, start the setup guide (R-28)');
  }
  const check = deps.setupGaps;
  const setupGaps =
    check === undefined
      ? async (): Promise<readonly SetupGap[]> => []
      : cachedSetupGaps({ check, now: () => now().getTime(), logger });
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
  // DK-23 AC4: "Probar": one call, never retried, counted against the budget.
  const probe = createModelProbe({
    complete,
    model,
    budget,
    gaps: setupGaps,
    timeoutMs: config.processorTimeoutMs,
    logger,
  });

  const phraser = createPiAiReplyPhraser({ complete: ai, model, logger });
  // R-16 AC3, DK-16: every exchange with the principal is a recent turn, kept in the stored
  // conversation, which survives a restart; the interpreter reads only the latest ones.
  const turns = createRecentTurns({ db, now, logger });
  // R-13 AC2: S-12 goes out unasked through `notify`, which needs the bot, while the bot needs the
  // handlers that offer it; it is bound below, before the bot starts polling.
  let notify: Notify = async () => {
    throw new Error('notify used before the bot was created');
  };
  const patterns = createPatternOffers({ db, now, logger, notify: (message) => notify(message) });
  const correcting = {
    db,
    interpreter: createPiAiCorrectionInterpreter({ complete: ai, model, logger }),
    timeZone: config.timeZone,
    now,
    logger,
    patterns,
  };
  const onText = createTextRouter({
    db,
    corrections: {
      register_expense: createExpenseCorrection(correcting),
      // R-7 AC6: the text after "Corregir" under a typed expense's reply.
      amend_expense: createAmendExpenseCorrection(correcting),
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
      routes: (message) => routesOf(doorOf(message.channelRef)),
      // T17: what the connected servers can do, so a search on the web goes to them and not to
      // the computer. Never connects a server: one not connected yet offers its read-only tools.
      connected: async () =>
        deps.connections === undefined
          ? (servers?.known() ?? [])
          : (await deps.connections()).flatMap(({ name, tools }) =>
              tools.map((tool) => ({ server: name, tool: tool.name, purpose: tool.description })),
            ),
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
      // R-16 AC3, DK-16: a confirmed forget erases the stored conversation and so the turns.
      forget_memory: createForgetMemoryAnswerHandler({ clearRecentTurns: turns.clear }),
      // DK-14 AC4: "Sí" erases the history of what ANOMANDER did.
      forget_history: createForgetHistoryAnswerHandler({ clearRecentTurns: turns.clear }),
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
  // `notify`, both are bound below, once the bot exists. A login is made in Telegram only; the
  // app has its Suscripciones screen (DK-15).
  let send = async (_: DoorReply): Promise<void> => {
    throw new Error('send used before the bot was created');
  };
  let deleteMessage = async (_: string): Promise<void> => {
    throw new Error('deleteMessage used before the bot was created');
  };
  const login =
    deps.login === undefined || config.telegram === undefined
      ? undefined
      : createTelegramLogin({
          ...deps.login,
          send: (message) => send(message),
          deleteMessage: (channelRef) => deleteMessage(channelRef),
          logger,
        });
  // DK-13, security audit M5: a route starts only when its task is the principal's own words.
  const recordedText = recordingTurns(
    turns,
    (message) => message.text,
    groundedRoutes(onText, logger),
    (message) => doorOf(message.channelRef),
  );
  // A press is kept at the door it was made at: a stored Telegram reply can be pressed in the app.
  const recordedButton = (door: Door) =>
    recordingTurns(
      turns,
      (press: ButtonPress) => buttonTurn(pressedOption(db, press.data)),
      onButton,
      () => door,
    );
  const recordedReceipt = recordingTurns(
    turns,
    (receipt) => receiptTurn(receipt.caption),
    receipts.onReceipt,
    (receipt) => doorOf(receipt.channelRef),
  );

  // DK-14 AC2: each action is kept once it ended. A failure to keep it never changes the reply,
  // and is logged without the principal's words (AC5).
  const keep = (record: Omit<ActionRecord, 'endedAt'>): void => {
    try {
      recordAction(db, { ...record, endedAt: now().toISOString() });
    } catch (error) {
      logger.error('action history not saved', {
        kind: record.kind,
        reason: (error as Error).message,
      });
    }
  };

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
      const reading = await screenReader({
        question: question.text,
        image: question.image,
        memories: memoryNotesFor(db, question.text),
      });
      // DK-14 AC2: the question only, never the capture or what was read in it.
      keep({
        kind: 'screen',
        door: 'app',
        task: question.text,
        outcome: reading.kind,
        steps: null,
        calls: null,
      });
      switch (reading.kind) {
        case 'answer':
          return { text: reading.text };
        case 'budget_exhausted':
          return { text: strings.textLimitReached() };
        case 'provider_limit':
          return { text: strings.providerLimitReached() };
        case 'failed':
          return { text: strings.screenNotSeen() };
      }
    },
    () => 'app',
  );

  // DK-10: the next step of a task on the computer. The budgeted call, as a look at the screen.
  const computerPlanner = createPiAiComputerPlanner({
    complete: ai,
    model: deps.visionModel ?? model,
    logger,
  });
  const planStep = async (request: ComputerRequest): Promise<DoorReply> => {
    // DK-14 AC2: how a task ended and how many steps it took, never what they typed or pressed.
    const ended = (outcome: string) =>
      keep({
        kind: 'computer',
        door: 'app',
        task: request.task,
        outcome,
        steps: request.done.length,
        calls: null,
      });
    // AC4: a task that long is stopped here, whatever the app does.
    if (request.done.length >= MAX_COMPUTER_STEPS) {
      ended('too_many_steps');
      return { text: strings.computerTooManySteps(MAX_COMPUTER_STEPS) };
    }
    const plan = await computerPlanner({
      ...request,
      memories: memoryNotesFor(db, request.task),
    });
    if (plan.kind === 'end') ended(plan.completed ? 'done' : 'cannot');
    else if (plan.kind !== 'action') ended(plan.kind);
    switch (plan.kind) {
      case 'action':
        return { text: plan.text, computer: plan.action, confirm: plan.confirm };
      case 'end':
        // R-16 AC3: how the task ended is a recent turn; its steps are not.
        return turns.add(computerTurn(request.task), { text: plan.text }, 'app');
      case 'budget_exhausted':
        return { text: strings.textLimitReached() };
      case 'provider_limit':
        return { text: strings.providerLimitReached() };
      case 'failed':
        return { text: strings.computerFailed() };
    }
  };

  // DK-11: a task with the servers the principal connected. The processor asks for calls and
  // `connectionTasks` decides each one; a call that needs permission comes back with buttons.
  const read =
    deps.connections === undefined
      ? readConnections(config.mcpConfigPath, logger, config.mcpSecrets)
      : undefined;
  // DK-24 AC2, AC3: a "Permitir siempre" holds only for its server as `mcp.json` has it now, so
  // one of a server removed, renamed or changed is revoked at the start; a file that cannot be
  // read changes none.
  if (read !== undefined && !read.invalid) {
    const revoked = revokeConnectionToolsNotIn(db, read.identities, now().toISOString());
    if (revoked > 0) logger.info(`revoked ${revoked} connection grants of changed servers`);
  }
  const servers =
    read === undefined
      ? undefined
      : createConnections({
          config: read.config,
          identities: read.identities,
          logger,
          oauth: oauthKeeperFrom(config.mcpOAuth, deps.printOAuth ?? printOAuthForShell(), logger),
        });
  const connectionTasks = createConnectionTasks({
    complete: ai,
    model,
    connections: deps.connections ?? (async () => (await servers?.get()) ?? []),
    problems:
      deps.connectionProblems ??
      (() => ({
        invalid: read?.invalid ?? false,
        unreachable: [...(read?.leftOut ?? []), ...(servers?.unreachable() ?? [])],
      })),
    logger,
    // DK-14 AC2: which calls were sent or refused, never their arguments or results.
    decided: (call) => connectionSession.decided(call),
    // DK-24: code checks the principal's grant, never the processor.
    alwaysAllowed: (call) => connectionToolGranted(db, call),
  });

  // What every front door calls (DK-4 AC1). R-28: `/start`, and the guide while a provider is
  // not connected.
  const chatTurns = oneTurnAtATime();
  const { inTurn } = chatTurns;
  /**
   * R-28 AC4: the guide while setup is incomplete. The check runs before the turn, so a slow
   * provider never holds it (T14); inputs that wait for the same check keep their order.
   */
  const guided = <I, R>(handler: (input: I) => Promise<R>, door: Door | ((input: I) => Door)) => {
    // DK-23 AC5: each door gets the guide in its own words.
    const guideAt = (input: I, gaps: readonly SetupGap[]) =>
      (typeof door === 'function' ? door(input) : door) === 'app'
        ? appSetupGuide(gaps)
        : setupGuide(gaps);
    const turn = inTurn(async ({ input, gaps }: { input: I; gaps: readonly SetupGap[] }) =>
      gaps.length > 0 ? { text: guideAt(input, gaps) } : handler(input),
    );
    return async (input: I) => turn({ input, gaps: await setupGaps() });
  };
  const byChannelRef = ({ channelRef }: { channelRef: string }) => doorOf(channelRef);

  // DK-11: one task with connections at a time, its steps outside the chat's turn (session.ts).
  const connectionSession = createConnectionSession({
    tasks: connectionTasks,
    turnLock: chatTurns,
    turns,
    keep,
    send: (message) => send(message),
    // DK-24 AC1: the principal's press on "Permitir siempre", where they pressed it.
    grant: (call, door) => {
      grantConnectionTool(db, call, door, now().toISOString());
    },
    logger,
  });

  const onButtonAt = (door: Door) => {
    const pressed = guided(async (press: ButtonPress) => {
      const answer = connectionSession.answer(press.data, door);
      return answer === undefined ? recordedButton(door)(press) : answer;
    }, door);
    return async (press: ButtonPress) => settled(await pressed(press));
  };
  // DK-17 AC6: "Deshacer" and "Corregir" on a row of "Gastos" press the expense's own button
  // (R-7 AC4 to AC8) in the chat's turn, as a press at the app's door: same answer, same turn.
  const pressRow = (option: RowOption) => {
    const pressed = guided(
      recordingTurns(
        turns,
        () => buttonTurn(rowLabel(option)),
        async (expenseId: number) => {
          const at = now().toISOString();
          const data = rowButton(db, { expenseId, option, now: at });
          if (data !== null) return onButton({ data, channelRef: 'desktop:gastos', pressedAt: at });
          // R-7 AC8: undone or corrected meanwhile, or never an expense: S-19, nothing changes.
          logger.info('row press for an expense no longer current', { expenseId });
          return { text: strings.decisionClosed() };
        },
        () => 'app',
      ),
      'app',
    );
    return async (expenseId: number) => settled(await pressed(expenseId));
  };
  const onConnectAt = (door: Door) => {
    const begun = guided(
      async (task: string) =>
        task === '' ? { text: strings.connectionUsage() } : connectionSession.run(task, door),
      door,
    );
    return async (task: string) => settled(await begun(task));
  };
  const connectFromApp = onConnectAt('app');
  const connectFromTelegram = onConnectAt('telegram');
  const answered = guided(async (message: PrincipalText): Promise<DoorReply | Later | null> => {
    if (isStart(message.text)) return { text: strings.hello() };
    // R-29 AC4: Telegram handles `/exportar` before this; the app gets S-81.
    if (isExport(message.text)) return { text: strings.exportOnlyInTelegram() };
    const reply = await recordedText(message);
    // DK-13 AC2: a task with connections asked in words runs as one asked with `connect`.
    const { route } = reply;
    if (route?.to !== 'connect') return reply;
    // Telegram's answer goes out by itself when the task ends: the announcement goes now.
    // DK-16 AC1: its words are stored once, with the announcement, above.
    const run = connectionSession.run(route.task, doorOf(message.channelRef), true);
    return run ?? { text: reply.text };
  }, byChannelRef);

  // R-29 AC3: the ledger's files, sent by Telegram after S-79; no processor call.
  const exportFromTelegram = guided(async (): Promise<DoorReply> => {
    try {
      const { files } = exportLedger(db, dirname(config.dbPath), now());
      return {
        text: strings.exportSent(),
        files: files.map((path) => ({ path, name: basename(path) })),
        // R-29 AC3: a file Telegram still refuses gets S-80 too.
        filesFailed: strings.exportFailed(),
      };
    } catch (error) {
      // The error's message names the folder, and the path may name the principal: only its code.
      logger.error('the ledger export failed', {
        reason:
          (error as NodeJS.ErrnoException).code ??
          (error instanceof Error ? error.name : 'unknown'),
      });
      return { text: strings.exportFailed() };
    }
  }, 'telegram');

  const chat: ChatHandlers = {
    onText: async (message) => settled(await answered(message)),
    onReceipt: guided(recordedReceipt, byChannelRef),
    onButton: onButtonAt('telegram'),
    onScreen: guided(recordedScreen, 'app'),
    onComputer: guided(planStep, 'app'),
    onConnect: (request) => connectFromApp(request.task),
  };

  const telegram = openTelegramDoor(
    config.telegram,
    {
      // R-17 AC7: `/login`, `/logout`, their buttons and the text a running login waits for come
      // before every other route. They never reach the processor and are never recent turns, so
      // never stored (DK-16). A login is made in Telegram only: its messages go out through the bot.
      onText: async (message) => {
        const handled = await login?.handleText(message);
        if (handled !== undefined) return handled.reply;
        if (isExport(message.text)) return exportFromTelegram(undefined);
        // DK-11: `/mcp <tarea>` asks for a task with connections, as `connect` does in the app.
        const task = connectionCommand(message.text);
        return task === undefined ? chat.onText(message) : connectFromTelegram(task);
      },
      onReceipt: chat.onReceipt,
      onButton: async (press) => {
        const handled = await login?.handleButton(press);
        return handled === undefined ? chat.onButton(press) : handled.reply;
      },
    },
    { logger, apiRoot: deps.telegramApiRoot },
  );

  // R-8, R-10, R-12 AC3, R-13 AC2, R-19, R-25 AC7 and R-26 AC5 send messages the principal did
  // not ask for. Without Telegram they have no door (the local channel only answers, DK-4 AC5)
  // and `notify` rejects, as a failed send does: a receipt stays queued until it can be told
  // about (R-8 AC5), and an S-12 is not offered.
  notify = recordingNotices(turns, telegram.send);
  send = telegram.send;
  deleteMessage = telegram.deleteMessage;
  // Without Telegram the jobs that only send wait instead of failing every minute: a reminder
  // goes out late once Telegram is set up (R-25 AC7); the digest and the summary are skipped.
  const unasked = <T>(job: () => Promise<T>) =>
    config.telegram === undefined ? async () => undefined : job;
  const retention = createRetention({
    db,
    inboxDir: config.inboxDir,
    timeZone: config.timeZone,
    now,
    notify,
    logger,
  });
  // B5: right after retention, so the day's copy holds nothing retention erased (§16).
  const dailyBackup = createDailyBackup({ db, now, logger });
  const summary = createWeeklySummary({ db, timeZone: config.timeZone, now, notify });
  const queue = createReceiptQueue({ db, readQueued: receipts.readQueued, notify, now, logger });
  const dueReminders = createDueReminders({ db, timeZone: config.timeZone, now, notify, logger });
  const digest = createMorningDigest({ db, timeZone: config.timeZone, now, notify, logger });
  const scheduler = startScheduler({
    retentionCron: config.retentionCron,
    weeklySummaryCron: config.weeklySummaryCron,
    timeZone: config.timeZone,
    jobs: {
      retain: async () => {
        try {
          return await retention.retain();
        } finally {
          await dailyBackup.run();
        }
      },
      sendMorningDigest: unasked(digest.send),
      sendDueReminders: unasked(dueReminders.send),
      // T13 F1: a receipt is read only where its reply can be told; it waits for Telegram.
      drainQueue: unasked(queue.drain),
      watchReceipts: retention.watchQueuedReceipts,
      sendWeeklySummary: unasked(summary.send),
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

  // DK-16: the app shows the stored conversation of both doors and can erase it. AC4: the erase
  // waits for the turn that runs, so nothing of that turn is stored after it.
  const clearInTurn = inTurn(async () => turns.clear());
  // DK-18: a forget from the window waits for the turn that runs too, as the erase does, so a
  // turn that says it is stored before it and goes with it. Only the turns that say it go.
  const forgetMemoryInTurn = inTurn(async (id: number) => {
    forgetMemoryAndItsTurns(db, id);
  });
  const forgetActionInTurn = inTurn(async (id: number) => {
    forgetAction(db, id);
  });
  const localChannel = startChannel(
    config,
    {
      ...chat,
      // R-17 AC7: while a login waits, the app's next text goes to it first, before any other
      // route: it is never stored, logged, a recent turn or sent to the model. `/login` and
      // `/logout` are not taken here: they stay in Telegram (DK-4 AC7).
      onText: async (message) =>
        login?.takePasted(message.text) === true ? null : chat.onText(message),
      onButton: onButtonAt('app'),
    },
    { messages: (limit) => storedConversation(db, limit), clear: () => clearInTurn(undefined) },
    {
      memories: () => listMemories(db),
      forgetMemory: forgetMemoryInTurn,
      actions: () =>
        listActions(db).map(({ id, kind, door, task, outcome, endedAt }) => ({
          id,
          what: kind,
          door,
          task,
          outcome,
          at: endedAt,
        })),
      forgetAction: forgetActionInTurn,
    },
    // DK-17: the "Gastos" screen, over the views of RA-1.
    {
      month: (month) => readExpensesMonth(db, { month, timeZone: config.timeZone, now: now() }),
      undo: pressRow('undo'),
      correct: pressRow('correct'),
    },
    logger,
    now,
    // DK-24 AC3: the "Permitir siempre" in force, for "Conexiones", and "Quitar".
    {
      list: () =>
        connectionToolGrants(db).map(({ id, server, tool, grantedAt }) => ({
          id,
          server,
          tool,
          at: grantedAt,
        })),
      revoke: (id) => revokeConnectionTool(db, id, now().toISOString()),
    },
    probe,
  );

  telegram.started.then(
    () =>
      setupGaps()
        .then((gaps) =>
          announceGaps(gaps, config.telegram === undefined ? undefined : send, logger),
        )
        .catch((error: unknown) => logger.error('Could not check the setup', { error })),
    () => {},
  );

  return {
    started: telegram.started,
    polling: telegram.ended,
    readApi: readApi?.listening,
    localChannel: localChannel?.listening,
    // T14: nothing new starts once this begins; the turns and jobs that run end, up to a
    // deadline, before the store closes. A step that fails is reported after the rest closed.
    stop: async () => {
      chatTurns.close();
      login?.stop();
      const failures: unknown[] = [];
      const settle = async (...steps: (Promise<unknown> | undefined)[]): Promise<void> => {
        for (const step of await Promise.allSettled(steps)) {
          if (step.status === 'rejected') failures.push(step.reason);
        }
      };
      const deadlineMs = deps.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS;
      // A scheduled job is waited for however long it takes, as before T14: it may be reading a
      // receipt, and neither the store nor the lock may go from under it.
      const jobs = settle(scheduler.stop());
      const ended = settle(localChannel?.stop(), telegram.stop(), chatTurns.drained());
      if (!(await settlesWithin(ended, deadlineMs))) {
        logger.warn(`anomander stopped before every turn ended: ${deadlineMs} ms passed`);
      }
      await jobs;
      await settle(servers?.close(), readApi?.stop());
      db.close();
      lock.release();
      if (failures.length > 0) throw failures[0];
    },
  };
};
