import type { Notify } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { createDailyBackup } from '../backup/daily-backup.ts';
import { createReceiptQueue, type ReceiptQueueDeps } from '../budget/receipt-queue.ts';
import type { Config } from '../config.ts';
import { createMorningDigest } from '../digest/send-digest.ts';
import type { Logger } from '../processor/ports.ts';
import { createDueReminders } from '../reminders/send-due.ts';
import { createRetention } from '../retention/retention-job.ts';
import { type SchedulerJobs, startScheduler } from '../scheduler/scheduler.ts';
import { createWeeklySummary } from '../summary/weekly-summary.ts';

export interface JobsDeps {
  config: Config;
  db: Database.Database;
  now: () => Date;
  notify: Notify;
  logger: Logger;
  /** The receipt cycle's `readQueued`. */
  readQueued: ReceiptQueueDeps['readQueued'];
  /** Whether a door can take a message the principal did not ask for now. */
  reachable: () => boolean;
}

/** What a job is, as the scheduler names it (`SchedulerJobs`). */
export type JobKind = keyof SchedulerJobs;

/**
 * The one chain every job runs in (DK-22), so two jobs never overlap whoever started them: a
 * receipt is never read while retention may delete its images. Once `halt` is called no job
 * starts, even one already queued (B69); `idle` settles when the one that runs has ended, and
 * `running` says which kind it is (B82).
 */
const jobChain = () => {
  let tail: Promise<unknown> = Promise.resolve();
  let halted = false;
  let running: JobKind | undefined;
  const oneAtATime =
    <T>(kind: JobKind, job: () => Promise<T>) =>
    (): Promise<T | undefined> => {
      const run = tail.then(async () => {
        if (halted) return undefined;
        running = kind;
        try {
          return await job();
        } finally {
          running = undefined;
        }
      });
      tail = run.catch(() => {});
      return run;
    };
  /**
   * B69: one waiting run per job. Asked again while a run waits for its turn, it answers that
   * run, so a storm of connections queues each job once; asked once that run started, it queues
   * another, which sees what changed meanwhile.
   */
  const merged = <T>(kind: JobKind, job: () => Promise<T>): (() => Promise<T | undefined>) => {
    let waiting: Promise<T | undefined> | undefined;
    const queue = oneAtATime(kind, () => {
      waiting = undefined;
      return job();
    });
    return () => {
      waiting ??= queue();
      return waiting;
    };
  };
  return {
    oneAtATime,
    merged,
    halt: () => {
      halted = true;
    },
    running: (): JobKind | undefined => running,
    idle: async (): Promise<void> => {
      let last: Promise<unknown>;
      do {
        last = tail;
        await last;
      } while (last !== tail);
    },
  };
};

/**
 * The scheduled jobs, started; `sendMorningDigest`, `sendDueReminders` and `drainQueue` also run
 * when the app connects (DK-22), through the same chain. `stop` starts no job after it, and waits
 * for the one that runs however long it takes, so the store is never closed from under it.
 */
export const startJobs = ({ config, db, now, notify, logger, readQueued, reachable }: JobsDeps) => {
  const chain = jobChain();
  const oneJobAtATime = chain.oneAtATime;
  const unasked = <T>(kind: JobKind, job: () => Promise<T>) =>
    chain.merged(kind, async () => (reachable() ? job() : undefined));
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
  const queue = createReceiptQueue({ db, readQueued, notify, now, logger });
  const dueReminders = createDueReminders({ db, timeZone: config.timeZone, now, notify, logger });
  const digest = createMorningDigest({ db, timeZone: config.timeZone, now, notify, logger });
  const sendMorningDigest = unasked('sendMorningDigest', digest.send);
  const sendDueReminders = unasked('sendDueReminders', dueReminders.send);
  const drainQueue = unasked('drainQueue', queue.drain);
  const scheduler = startScheduler({
    retentionCron: config.retentionCron,
    weeklySummaryCron: config.weeklySummaryCron,
    timeZone: config.timeZone,
    jobs: {
      retain: oneJobAtATime('retain', async () => {
        try {
          return await retention.retain();
        } finally {
          await dailyBackup.run();
        }
      }),
      sendMorningDigest,
      sendDueReminders,
      // T13 F1: a receipt is read only where its reply can be told; it waits for a door.
      drainQueue,
      watchReceipts: oneJobAtATime('watchReceipts', retention.watchQueuedReceipts),
      sendWeeklySummary: unasked('sendWeeklySummary', summary.send),
    },
    logger,
  });
  return {
    scheduler,
    sendMorningDigest,
    sendDueReminders,
    drainQueue,
    /** B82: the kind of the job that runs now, if one does; never what it holds. */
    running: chain.running,
    /** Nothing starts from now on: no scheduled job, no run a connection asked for. */
    halt: () => {
      chain.halt();
      scheduler.halt();
    },
    stop: async (): Promise<void> => {
      chain.halt();
      await scheduler.stop();
      await chain.idle();
    },
  };
};
