import { Cron } from 'croner';
import type { Logger } from '../processor/text-interpreter.ts';

// The daemon's clock (PRD §14.3). R-19: retention runs once at startup and then at
// `ANOMANDER_RETENTION_CRON` in `TZ`. Every minute, the budget queue is read once the day has
// changed (R-12 AC3) and unread receipts get S-13 or are discarded on time (R-8 AC3, AC5).
// Jobs never overlap: they share one queue, so two of them never touch the same receipt.

export interface SchedulerJobs {
  /** R-19 AC1 to AC3. */
  retain(): Promise<unknown>;
  /** R-12 AC3: reads the queued receipts while the budget allows. */
  drainQueue(): Promise<unknown>;
  /** R-8 AC3 and AC5: S-13 before `keep_until`, S-14 after it. */
  watchReceipts(): Promise<unknown>;
}

export interface SchedulerDeps {
  /** `ANOMANDER_RETENTION_CRON`. */
  retentionCron: string;
  /** `TZ`: the cron expressions are read there. */
  timeZone: string;
  jobs: SchedulerJobs;
  logger: Logger;
}

export interface Scheduler {
  /** Resolves when the startup run has finished. */
  started: Promise<void>;
  /** Stops the schedule and waits for the job in progress. */
  stop(): Promise<void>;
}

const EVERY_MINUTE = '* * * * *';

export const startScheduler = ({
  retentionCron,
  timeZone,
  jobs,
  logger,
}: SchedulerDeps): Scheduler => {
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;
  let tickPending = false;

  const enqueue = (...names: (keyof SchedulerJobs)[]): Promise<void> => {
    for (const name of names) {
      tail = tail.then(async () => {
        if (stopped) return;
        try {
          await jobs[name]();
        } catch (error) {
          logger.error('scheduled job failed', { job: name, error });
        }
      });
    }
    return tail;
  };

  // An invalid pattern throws here, before anything runs.
  const crons = [
    new Cron(retentionCron, { timezone: timeZone, paused: true }, () => {
      void enqueue('retain');
    }),
    new Cron(EVERY_MINUTE, { timezone: timeZone, paused: true }, () => {
      // A slow minute does not pile up ticks behind it.
      if (tickPending) return;
      tickPending = true;
      void enqueue('drainQueue', 'watchReceipts').finally(() => {
        tickPending = false;
      });
    }),
  ];

  const started = enqueue('retain', 'drainQueue', 'watchReceipts');
  for (const cron of crons) cron.resume();

  return {
    started,
    stop: async () => {
      for (const cron of crons) cron.stop();
      stopped = true;
      await tail;
    },
  };
};
