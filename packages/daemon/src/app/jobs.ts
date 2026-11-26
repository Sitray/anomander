import type { Notify } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { createDailyBackup } from '../backup/daily-backup.ts';
import { createReceiptQueue, type ReceiptQueueDeps } from '../budget/receipt-queue.ts';
import type { Config } from '../config.ts';
import { createMorningDigest } from '../digest/send-digest.ts';
import type { Logger } from '../processor/ports.ts';
import { createDueReminders } from '../reminders/send-due.ts';
import { createRetention } from '../retention/retention-job.ts';
import { startScheduler } from '../scheduler/scheduler.ts';
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

/**
 * The one chain every job runs in (DK-22), so two jobs never overlap whoever started them: a
 * receipt is never read while retention may delete its images. Once `halt` is called no job
 * starts, even one already queued (B69); `idle` settles when the one that runs has ended.
 */
const jobChain = () => {
  let tail: Promise<unknown> = Promise.resolve();
  let halted = false;
  const oneAtATime =
    <T>(job: () => Promise<T>) =>
    (): Promise<T | undefined> => {
      const run = tail.then(() => (halted ? undefined : job()));
      tail = run.catch(() => {});
      return run;
    };
  /**
   * B69: one waiting run per job. Asked again while a run waits for its turn, it answers that
   * run, so a storm of connections queues each job once; asked once that run started, it queues
   * another, which sees what changed meanwhile.
   */
  const merged = <T>(job: () => Promise<T>): (() => Promise<T | undefined>) => {
    let waiting: Promise<T | undefined> | undefined;
    const queue = oneAtATime(() => {
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
  const unasked = <T>(job: () => Promise<T>) =>
    chain.merged(async () => (reachable() ? job() : undefined));
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
  const sendMorningDigest = unasked(digest.send);
  const sendDueReminders = unasked(dueReminders.send);
  const drainQueue = unasked(queue.drain);
  const scheduler = startScheduler({
    retentionCron: config.retentionCron,
    weeklySummaryCron: config.weeklySummaryCron,
    timeZone: config.timeZone,
    jobs: {
      retain: oneJobAtATime(async () => {
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
      watchReceipts: oneJobAtATime(retention.watchQueuedReceipts),
      sendWeeklySummary: unasked(summary.send),
    },
    logger,
  });
  return {
    scheduler,
    sendMorningDigest,
    sendDueReminders,
    drainQueue,
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
