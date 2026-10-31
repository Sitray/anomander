import { afterEach, describe, expect, it, vi } from 'vitest';
import { startScheduler } from '../../src/scheduler/scheduler.ts';

// R-19: the retention job runs once at startup and then at ANOMANDER_RETENTION_CRON in TZ; the
// queue (R-12 AC3) and the unread receipts (R-8 AC3, AC5) are checked at startup and every minute.
// R-10 AC1: the weekly summary goes out only at ANOMANDER_WEEKLY_SUMMARY_CRON in TZ. R-25 AC7: due
// reminders are sent at startup and every minute.
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const noJob = async () => {};
const crons = { retentionCron: '0 3 * * *', weeklySummaryCron: '0 20 * * 0' };

afterEach(() => {
  vi.useRealTimers();
});

describe('startScheduler', () => {
  it('runs retention, due reminders, the queue and the receipt watch once at startup, in that order', async () => {
    const order: string[] = [];
    const scheduler = startScheduler({
      ...crons,
      timeZone: 'Europe/Madrid',
      jobs: {
        retain: async () => void order.push('retain'),
        sendDueReminders: async () => void order.push('sendDueReminders'),
        drainQueue: async () => void order.push('drainQueue'),
        watchReceipts: async () => void order.push('watchReceipts'),
        sendWeeklySummary: async () => void order.push('sendWeeklySummary'),
      },
      logger: logger(),
    });

    await scheduler.started;
    await scheduler.stop();

    expect(order).toEqual(['retain', 'sendDueReminders', 'drainQueue', 'watchReceipts']);
  });

  it('logs a failing job and still runs the next one', async () => {
    const log = logger();
    const watched = vi.fn(async () => {});
    const scheduler = startScheduler({
      ...crons,
      timeZone: 'Europe/Madrid',
      jobs: {
        retain: async () => {
          throw new Error('disk full');
        },
        sendDueReminders: noJob,
        drainQueue: async () => {},
        watchReceipts: watched,
        sendWeeklySummary: noJob,
      },
      logger: log,
    });

    await scheduler.started;
    await scheduler.stop();

    expect(log.error).toHaveBeenCalledWith('scheduled job failed', {
      job: 'retain',
      error: expect.any(Error),
    });
    expect(watched).toHaveBeenCalledOnce();
  });

  it('rejects an invalid ANOMANDER_RETENTION_CRON', () => {
    expect(() =>
      startScheduler({
        ...crons,
        retentionCron: 'every night',
        timeZone: 'Europe/Madrid',
        jobs: {
          retain: noJob,
          sendDueReminders: noJob,
          drainQueue: noJob,
          watchReceipts: noJob,
          sendWeeklySummary: noJob,
        },
        logger: logger(),
      }),
    ).toThrow();
  });

  it('sends the weekly summary at ANOMANDER_WEEKLY_SUMMARY_CRON in TZ, not at startup', async () => {
    // Sunday 1 November 2026, 19:59 in Madrid (UTC+1).
    vi.useFakeTimers({ now: new Date('2026-11-01T18:59:00.000Z') });
    const summaries: string[] = [];
    const scheduler = startScheduler({
      ...crons,
      timeZone: 'Europe/Madrid',
      jobs: {
        retain: noJob,
        sendDueReminders: noJob,
        drainQueue: noJob,
        watchReceipts: noJob,
        sendWeeklySummary: async () => void summaries.push(new Date().toISOString()),
      },
      logger: logger(),
    });
    await scheduler.started;
    expect(summaries).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(summaries).toEqual(['2026-11-01T19:00:00.000Z']);

    // 20:00 UTC is not the configured time: the cron is read in TZ.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(summaries).toHaveLength(1);

    await scheduler.stop();
  });

  it('sends due reminders, reads the queue and watches receipts every minute, not retention', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-30T10:00:30.000Z') });
    const order: string[] = [];
    const scheduler = startScheduler({
      ...crons,
      timeZone: 'Europe/Madrid',
      jobs: {
        retain: async () => void order.push('retain'),
        sendDueReminders: async () => void order.push('sendDueReminders'),
        drainQueue: async () => void order.push('drainQueue'),
        watchReceipts: async () => void order.push('watchReceipts'),
        sendWeeklySummary: noJob,
      },
      logger: logger(),
    });
    await scheduler.started;
    order.length = 0;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(order).toEqual(['sendDueReminders', 'drainQueue', 'watchReceipts']);

    await scheduler.stop();
  });
});
