import { HISTORY_LIMIT, type Notify } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRecentTurns,
  NO_DOOR,
  recordingNotices,
} from '../../src/conversation/recent-turns.ts';
import { storedConversation } from '../../src/store/conversation.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// B75: the independent verifier's probes of the fan-out to Telegram and the app, kept as
// regression tests.
const AT = '2026-10-31T10:00:00.000Z';
let db: Database.Database;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  db = openDatabase(':memory:');
  applyMigrations(db);
});
afterEach(() => db.close());
const stored = () =>
  storedConversation(db, HISTORY_LIMIT).map((t) => [t.door, t.channelRef, t.text]);
const turns = () => createRecentTurns({ db, now: () => new Date(AT), logger });
const door =
  (ref: string, outcome: 'ok' | 'fail' | 'twice', delay = 0): Notify =>
  async (m) => {
    await new Promise((r) => setTimeout(r, delay));
    if (outcome === 'fail') throw new Error(`${ref} failed`);
    m.onDelivered?.({ channelRef: ref, deliveredAt: AT });
    if (outcome === 'twice') m.onDelivered?.({ channelRef: `${ref}-again`, deliveredAt: AT });
  };
const app = (n: Notify, connected = true) => ({ connected: () => connected, notify: n });

describe('verifier probes: a message unasked to both doors (B75)', () => {
  const cases: [
    string,
    Notify | undefined,
    ReturnType<typeof app> | undefined,
    string | null,
    string | null,
    boolean,
  ][] = [
    // name, telegram, app, stored ref, onDelivered ref, warn
    [
      'both deliver, app first',
      door('telegram:1', 'ok', 20),
      app(door('desktop:1', 'ok', 0)),
      'telegram:1',
      'telegram:1',
      false,
    ],
    [
      'both deliver, telegram first',
      door('telegram:1', 'ok', 0),
      app(door('desktop:1', 'ok', 20)),
      'telegram:1',
      'telegram:1',
      false,
    ],
    [
      'telegram fails, app delivers',
      door('telegram:1', 'fail', 10),
      app(door('desktop:1', 'ok', 0)),
      'desktop:1',
      'desktop:1',
      true,
    ],
    [
      'app fails, telegram delivers',
      door('telegram:1', 'ok', 0),
      app(door('desktop:1', 'fail', 10)),
      'telegram:1',
      'telegram:1',
      false,
    ],
    [
      'no telegram, app delivers',
      undefined,
      app(door('desktop:1', 'ok')),
      'desktop:1',
      'desktop:1',
      false,
    ],
    [
      'telegram only',
      door('telegram:1', 'ok'),
      app(door('desktop:1', 'ok'), false),
      'telegram:1',
      'telegram:1',
      false,
    ],
    [
      'telegram reports twice',
      door('telegram:1', 'twice'),
      undefined,
      'telegram:1',
      'telegram:1',
      false,
    ],
  ];
  for (const [name, telegram, appDoor, ref, delivered, warn] of cases) {
    it(name, async () => {
      const onDelivered = vi.fn();
      await recordingNotices(turns(), telegram, appDoor, logger)({ text: 'hola', onDelivered });
      expect(stored()).toEqual([[ref?.startsWith('desktop') ? 'app' : 'telegram', ref, 'hola']]);
      expect(onDelivered).toHaveBeenCalledTimes(1);
      expect(onDelivered.mock.calls[0]?.[0].channelRef).toBe(delivered);
      expect(logger.warn).toHaveBeenCalledTimes(warn ? 1 : 0);
    });
  }

  it('both fail: rejects with Telegram failure, stores nothing, onDelivered never', async () => {
    const onDelivered = vi.fn();
    const send = recordingNotices(
      turns(),
      door('telegram:1', 'fail', 5),
      app(door('desktop:1', 'fail')),
      logger,
    );
    await expect(send({ text: 'hola', onDelivered })).rejects.toThrow('telegram:1 failed');
    expect(stored()).toEqual([]);
    expect(onDelivered).not.toHaveBeenCalled();
  });

  it('no door: rejects with NO_DOOR', async () => {
    const send = recordingNotices(turns(), undefined, app(door('desktop:1', 'ok'), false), logger);
    await expect(send({ text: 'hola' })).rejects.toThrow(NO_DOOR);
    expect(stored()).toEqual([]);
  });
});
