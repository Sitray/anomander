import { HISTORY_LIMIT, type Notify } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecentTurns, recordingNotices } from '../../src/conversation/recent-turns.ts';
import { storedConversation } from '../../src/store/conversation.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// B75 (R4-002): DK-22, a message sent unasked goes to Telegram and to the connected app at once:
// the app's copy never waits for Telegram, which may retry a refused send for seconds.
const AT = new Date('2026-10-31T10:00:00Z');

let db: Database.Database;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  db = openDatabase(':memory:');
  applyMigrations(db);
});

afterEach(() => {
  db.close();
});

const stored = () => storedConversation(db, HISTORY_LIMIT);

/** A Telegram send that waits until `settle` is called, as one Telegram makes retry. */
const slowTelegram = () => {
  let settle: (outcome: 'delivered' | Error) => void = () => {};
  const notify: Notify = (message) =>
    new Promise<void>((resolve, reject) => {
      settle = (outcome) => {
        if (outcome instanceof Error) return reject(outcome);
        message.onDelivered?.({ channelRef: 'telegram:9', deliveredAt: AT.toISOString() });
        resolve();
      };
    });
  return { notify, settle: (outcome: 'delivered' | Error) => settle(outcome) };
};

/** The connected app, which delivers at once. */
const appDoor = (pushed: string[]) => ({
  connected: () => true,
  notify: (async (message) => {
    pushed.push(message.text);
    message.onDelivered?.({ channelRef: 'desktop:1', deliveredAt: AT.toISOString() });
  }) satisfies Notify,
});

describe('a message sent unasked to both doors (DK-22, B75)', () => {
  it('reaches the app while Telegram still sends it, and is kept once, as Telegram gave it', async () => {
    const telegram = slowTelegram();
    const pushed: string[] = [];
    const delivered: string[] = [];
    const notify = recordingNotices(
      createRecentTurns({ db, now: () => AT, logger }),
      telegram.notify,
      appDoor(pushed),
      logger,
    );

    const sending = notify({
      text: 'Recordatorio',
      onDelivered: (delivery) => delivered.push(delivery.channelRef),
    });
    await vi.waitFor(() => expect(pushed).toEqual(['Recordatorio']));
    // Nothing is kept, and nobody is told, before both doors answered.
    expect(stored()).toEqual([]);
    expect(delivered).toEqual([]);

    telegram.settle('delivered');
    await sending;

    expect(delivered).toEqual(['telegram:9']);
    expect(stored()).toMatchObject([
      { from: 'anomander', door: 'telegram', channelRef: 'telegram:9' },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('when Telegram fails after the app got it, is kept as the app gave it, with the fixed line', async () => {
    const telegram = slowTelegram();
    const pushed: string[] = [];
    const delivered: string[] = [];
    const notify = recordingNotices(
      createRecentTurns({ db, now: () => AT, logger }),
      telegram.notify,
      appDoor(pushed),
      logger,
    );

    const sending = notify({
      text: 'Recordatorio: llamar a mamá.',
      onDelivered: (delivery) => delivered.push(delivery.channelRef),
    });
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    telegram.settle(new Error('429: Too Many Requests: llamar a mamá'));
    await sending;

    expect(delivered).toEqual(['desktop:1']);
    expect(stored()).toMatchObject([{ from: 'anomander', door: 'app', channelRef: 'desktop:1' }]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'an unasked message reached the app but not Telegram',
    );
  });
});
