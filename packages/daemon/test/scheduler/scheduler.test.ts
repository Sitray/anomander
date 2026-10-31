import { describe, expect, it, vi } from 'vitest';
import { startScheduler } from '../../src/scheduler/scheduler.ts';

// R-19: the retention job runs once at startup and then at ANOMANDER_RETENTION_CRON in TZ; the
// queue (R-12 AC3) and the unread receipts (R-8 AC3, AC5) are checked at startup and every minute.
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('startScheduler', () => {
  it('runs retention, the queue and the receipt watch once at startup, in that order', async () => {
    const order: string[] = [];
    const scheduler = startScheduler({
      retentionCron: '0 3 * * *',
      timeZone: 'Europe/Madrid',
      jobs: {
        retain: async () => void order.push('retain'),
        drainQueue: async () => void order.push('drainQueue'),
        watchReceipts: async () => void order.push('watchReceipts'),
      },
      logger: logger(),
    });

    await scheduler.started;
    await scheduler.stop();

    expect(order).toEqual(['retain', 'drainQueue', 'watchReceipts']);
  });

  it('logs a failing job and still runs the next one', async () => {
    const log = logger();
    const watched = vi.fn(async () => {});
    const scheduler = startScheduler({
      retentionCron: '0 3 * * *',
      timeZone: 'Europe/Madrid',
      jobs: {
        retain: async () => {
          throw new Error('disk full');
        },
        drainQueue: async () => {},
        watchReceipts: watched,
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
        retentionCron: 'every night',
        timeZone: 'Europe/Madrid',
        jobs: { retain: async () => {}, drainQueue: async () => {}, watchReceipts: async () => {} },
        logger: logger(),
      }),
    ).toThrow();
  });
});
