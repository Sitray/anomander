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
 * The scheduled jobs, started; `sendMorningDigest`, `sendDueReminders` and `drainQueue` also run
 * when the app connects (DK-22), through the same chain.
 */
export const startJobs = ({ config, db, now, notify, logger, readQueued, reachable }: JobsDeps) => {
  // DK-22: they also run when the app connects. Every scheduled job and those runs go through
  // this one chain, so two jobs never overlap (a receipt is never read while retention may
  // delete its images), whoever started them.
  let jobRuns: Promise<unknown> = Promise.resolve();
  const oneJobAtATime =
    <T>(job: () => Promise<T>) =>
    (): Promise<T> => {
      const run = jobRuns.then(job);
      jobRuns = run.catch(() => {});
      return run;
    };
  const unasked = <T>(job: () => Promise<T>) =>
    oneJobAtATime(async () => (reachable() ? job() : undefined));
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
  return { scheduler, sendMorningDigest, sendDueReminders, drainQueue };
};
