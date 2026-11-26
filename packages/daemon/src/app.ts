import { type DoorReply, type Notify, setCurrency, setLocale } from '@anomander/protocol';
import { createAppTasks } from './app/app-tasks.ts';
import { createChat } from './app/chat.ts';
import { connectionCommand, isExport } from './app/commands.ts';
import { setUpConnections } from './app/connections.ts';
import { createHandlers } from './app/handlers.ts';
import { startJobs } from './app/jobs.ts';
import { channelViews, startChannel } from './app/local-channel.ts';
import { watchingPastes } from './app/login-waits.ts';
import { announceGaps } from './app/setup-guide-mode.ts';
import { oneTurnAtATime } from './app/turns.ts';
import type { Anomander, AnomanderDeps } from './app/types.ts';
import { createTelegramLogin } from './auth/telegram-login.ts';
import type { Config } from './config.ts';
import { type AppNotices, recordingNotices } from './conversation/recent-turns.ts';
import { NO_APP, TAKEN_BY_LOGIN } from './local-channel/server.ts';
import type { ConnectedTool } from './processor/ports.ts';
import { startReadApi } from './read-api/server.ts';
import { cachedSetupGaps, type SetupGap } from './setup/setup-guide.ts';
import { acquireDaemonLock } from './store/daemon-lock.ts';
import { applyMigrations, openDatabase } from './store/database.ts';
import { openTelegramDoor } from './telegram-door.ts';

// The composition root: one process, one SQLite file, the front doors in the same process (PRD
// §14.3): Telegram while it is configured, the desktop app's local channel while
// `ANOMANDER_LOCAL_TOKEN` is set, at least one of them (`loadConfig`). `main.ts` passes pi-ai's
// `models.complete`; the e2e test passes recorded responses and the fake Telegram API.

export { type SetupGuideDeps, startSetupGuide } from './app/setup-guide-mode.ts';
export type { Anomander, AnomanderDeps } from './app/types.ts';

/** T14: how long a shutdown waits for the turns that run before it closes the store. */
export const SHUTDOWN_DEADLINE_MS = 5_000;

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

export const startAnomander = <M>(config: Config, deps: AnomanderDeps<M>): Anomander => {
  // Before any text is built: one daemon speaks one language for its whole life, and writes new
  // expenses in one currency (DK-25).
  setLocale(config.locale);
  setCurrency(config.currency);
  const { model, logger = console, now = () => new Date() } = deps;
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
  // B52: the path may name the principal (§16), so the log leaves it out.
  logger.info(`anomander store ready (${applied} migrations applied)`);

  // R-13 AC2: S-12 goes out unasked through `notify`, which needs the bot, while the bot needs the
  // handlers that offer it; it is bound below, before the bot starts polling.
  let notify: Notify = async () => {
    throw new Error('notify used before the bot was created');
  };
  const { budget, ai, probe, turns, onText, receipts, onButton } = createHandlers({
    config,
    db,
    deps,
    textModel,
    visionModel,
    setupGaps,
    notify: (message) => notify(message),
    // T17: what the connected servers can do, so a search on the web goes to them and not to
    // the computer. Never connects a server: one not connected yet offers its read-only tools.
    connected: async (): Promise<readonly ConnectedTool[]> =>
      deps.connections === undefined
        ? (servers?.known() ?? [])
        : (await deps.connections()).flatMap(({ name, tools }) =>
            tools.map((tool) => ({ server: name, tool: tool.name, purpose: tool.description })),
          ),
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
  // B81: bound below, once the local channel exists.
  let loginWaiting = (_: boolean): void => {};
  const login =
    deps.login === undefined || config.telegram === undefined
      ? undefined
      : createTelegramLogin({
          ...deps.login,
          // B81 (DK-4 AC7): the app's windows are told while it waits for a pasted text.
          models: watchingPastes(deps.login.models, (waiting) => loginWaiting(waiting)),
          send: (message) => send(message),
          deleteMessage: (channelRef) => deleteMessage(channelRef),
          logger,
        });
  // DK-14, DK-10: the history of what ANOMANDER did, a look at the screen and a task on the computer.
  const { keep, recordedScreen, planStep } = createAppTasks({
    db,
    ai,
    deps,
    model,
    turns,
    now,
    logger,
  });

  const { servers, connectionTasks } = setUpConnections({
    config,
    db,
    deps,
    ai,
    model,
    decided: (call) => connectionSession.decided(call),
    now,
    logger,
  });

  // What every front door calls (DK-4 AC1). R-28: `/start`, and the guide while a provider is
  // not connected.
  const chatTurns = oneTurnAtATime();
  /** Set once `stop` begins: nothing new starts after it. */
  let stopping = false;
  const { inTurn } = chatTurns;
  const { chat, connectionSession, onButtonAt, pressRow, connectFromTelegram, exportFromTelegram } =
    createChat({
      config,
      db,
      turns,
      chatTurns,
      setupGaps,
      onText,
      onButton,
      receipts,
      recordedScreen,
      planStep,
      keep,
      connectionTasks,
      send: (message) => send(message),
      now,
      logger,
    });

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
  // not ask for. They go to Telegram, and to the app while it is connected (DK-22), through one
  // fan-out. With neither door `notify` rejects, as a failed send does: a receipt stays queued
  // until it can be told about (R-8 AC5), and an S-12 is not offered.
  // The app's door is bound below, once its channel exists.
  let app: AppNotices = {
    connected: () => false,
    notify: async () => {
      throw new Error(NO_APP);
    },
  };
  notify = recordingNotices(
    turns,
    config.telegram === undefined ? undefined : telegram.send,
    { connected: () => app.connected(), notify: (message) => app.notify(message) },
    logger,
  );
  send = telegram.send;
  deleteMessage = telegram.deleteMessage;
  // With no door the jobs that only send wait instead of failing every minute: a reminder goes
  // out late once a door is there (R-25 AC7), the digest is tried again until noon (R-26 AC5) and
  // the summary is skipped (decision 5 of the desktop PRD).
  const reachable = () => config.telegram !== undefined || app.connected();
  // DK-22: every scheduled job, and their runs when the app connects (below), go through one
  // chain inside `startJobs`, so two jobs never overlap.
  const jobs = startJobs({
    config,
    db,
    now,
    notify,
    logger,
    readQueued: receipts.readQueued,
    reachable,
  });

  // RA-2: the read API, only while `ANOMANDER_API_TOKEN` is set (AC1). It opens its own
  // read-only connection, after the migrations created the views it reads.
  const { sendMorningDigest, sendDueReminders, drainQueue } = jobs;

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

  // DK-16, DK-17, DK-18, DK-24: what the app's windows read and change, in the chat's turn.
  const views = channelViews({ config, db, turns, inTurn, pressRow, now });
  const localChannel = startChannel(
    config,
    {
      ...chat,
      // R-17 AC7: while a login waits, the app's next text goes to it first, before any other
      // route: it is never stored, logged, a recent turn or sent to the model. `/login` and
      // `/logout` are not taken here: they stay in Telegram (DK-4 AC7).
      onText: async (message) =>
        login?.takePasted(message.text) === true ? TAKEN_BY_LOGIN : chat.onText(message),
      onButton: onButtonAt('app'),
    },
    views.conversation,
    views.memory,
    views.expenses,
    logger,
    now,
    views.grants,
    probe,
    // DK-21: today's AI calls, for the setup screen.
    budget.usage,
    // DK-22: what waited for a door goes out as soon as the app connects, as the next minute's
    // run would send it, in the scheduler's order. Never once the daemon stops.
    () => {
      if (stopping) return;
      for (const [name, job] of [
        ['sendMorningDigest', sendMorningDigest],
        ['sendDueReminders', sendDueReminders],
        ['drainQueue', drainQueue],
      ] as const) {
        // Not a turn: `jobs.stop` waits for it, never the turns' deadline.
        job().catch((error: unknown) => logger.error('scheduled job failed', { job: name, error }));
      }
    },
  );
  if (localChannel !== undefined) app = localChannel;
  loginWaiting = (waiting) => localChannel?.loginWaiting(waiting);

  telegram.started.then(
    () =>
      setupGaps()
        .then((gaps) =>
          announceGaps(gaps, config.telegram === undefined ? undefined : send, logger),
        )
        .catch((error: unknown) => logger.error('Could not check the setup', { error })),
    () => {},
  );

  // B51: nothing new starts once this is called: no turn, no job, no input of a door. The doors
  // begin to close; `stop` waits for them. B82: a crash (`crashed`) halts the bot without
  // acknowledging a Telegram text whose turn never started, so it comes again after the restart;
  // a stop answers it as failed, as before.
  let doorsClosing: Promise<unknown>[] | undefined;
  const halt = ({ crashed = false } = {}): Promise<unknown>[] => {
    if (doorsClosing !== undefined) return doorsClosing;
    stopping = true;
    chatTurns.close();
    login?.stop();
    jobs.halt();
    doorsClosing = [
      localChannel?.stop() ?? Promise.resolve(),
      crashed ? telegram.halt() : telegram.stop(),
    ];
    for (const closing of doorsClosing) closing.catch(() => {});
    return doorsClosing;
  };

  return {
    started: telegram.started,
    polling: telegram.ended,
    readApi: readApi?.listening,
    localChannel: localChannel?.listening,
    halt: () => {
      halt({ crashed: true });
    },
    // T14: nothing new starts once this begins; the turns that run end, up to a deadline, and
    // the jobs however long they take (B69), before the store closes. A step that fails is
    // reported after the rest closed.
    stop: async () => {
      const doors = halt();
      const failures: unknown[] = [];
      const settle = async (...steps: (Promise<unknown> | undefined)[]): Promise<void> => {
        for (const step of await Promise.allSettled(steps)) {
          if (step.status === 'rejected') failures.push(step.reason);
        }
      };
      const deadlineMs = deps.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS;
      // A job is waited for however long it takes, as before T14: it may be reading a receipt,
      // and neither the store nor the lock may go from under it. B69: that holds for a job the
      // app's connection started too; one still queued never starts.
      const jobsEnded = settle(jobs.stop());
      // B82: still waited for past the deadline, but told once, by its kind: a hung job holds the
      // stop until whoever started the daemon kills it.
      const jobsTold = settlesWithin(jobsEnded, deadlineMs).then((inTime) => {
        if (inTime) return;
        logger.warn(
          `anomander is still waiting for a job before it stops: ${deadlineMs} ms passed`,
          {
            job: jobs.running() ?? 'unknown',
          },
        );
      });
      const ended = settle(...doors, chatTurns.drained());
      if (!(await settlesWithin(ended, deadlineMs))) {
        logger.warn(`anomander stopped before every turn ended: ${deadlineMs} ms passed`);
      }
      await jobsTold;
      await jobsEnded;
      await settle(servers?.close(), readApi?.stop());
      db.close();
      lock.release();
      if (failures.length > 0) throw failures[0];
    },
  };
};
