import { HISTORY_LIMIT, type Reply } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRecentTurns,
  recordingNotices,
  recordingTurns,
} from '../../src/conversation/recent-turns.ts';
import { storedConversation } from '../../src/store/conversation.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// PRD R-16 AC3: the interpreter sees the last 10 turns, none older than 30 minutes. DK-16: they
// are read from the conversation kept in the local database, so they survive a restart.
const AT = new Date('2026-10-31T10:00:00Z');

let db: Database.Database;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  db = openDatabase(':memory:');
  applyMigrations(db);
});

afterEach(() => {
  db.close();
});

const stored = () => storedConversation(db, HISTORY_LIMIT);

describe('recent turns', () => {
  it('keeps only the last 10 turns, oldest first', () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    for (let i = 1; i <= 12; i++) turns.add(`message ${i}`, { text: `reply ${i}` }, 'app');

    const recent = turns.recent();

    expect(recent).toHaveLength(10);
    expect(recent[0]).toEqual({ principal: 'message 3', reply: 'reply 3' });
    expect(recent[9]).toEqual({ principal: 'message 12', reply: 'reply 12' });
  });

  it('drops turns older than 30 minutes', () => {
    let clock = AT;
    const turns = createRecentTurns({ db, now: () => clock, logger });
    turns.add('old', { text: 'old reply' }, 'app');
    clock = new Date('2026-10-31T10:20:00Z');
    turns.add('new', { text: 'new reply' }, 'telegram');
    clock = new Date('2026-10-31T10:30:01Z');

    expect(turns.recent()).toEqual([{ principal: 'new', reply: 'new reply' }]);
  });

  it('DK-16 S3: survives a restart: a new instance over the same database reads the last 30 minutes', () => {
    let clock = AT;
    const before = createRecentTurns({ db, now: () => clock, logger });
    before.add('old', { text: 'old reply' }, 'app');
    clock = new Date('2026-10-31T10:20:00Z');
    before.add('soy vegetariano', { text: 'Apuntado.' }, 'telegram');
    before.add(null, { text: 'Recordatorio: llamar a Marta' }, 'telegram');
    clock = new Date('2026-10-31T10:30:01Z');

    const after = createRecentTurns({ db, now: () => clock, logger });

    expect(after.recent()).toEqual([
      { principal: 'soy vegetariano', reply: 'Apuntado.' },
      { principal: null, reply: 'Recordatorio: llamar a Marta' },
    ]);
  });

  it('DK-16 S2: stores each turn as two messages, with the door, the buttons and the reference the reply was delivered with', () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const shown = vi.fn();
    const buttons = [
      { label: 'Sí', data: 'decision:1:0' },
      { label: 'No', data: 'decision:1:1' },
    ];

    const reply = turns.add(
      '[foto de ticket]',
      { text: '¿Lo apunto?', buttons, onDelivered: shown },
      'telegram',
    );
    const delivery = { channelRef: 'telegram:77', deliveredAt: AT.toISOString() };
    reply.onDelivered?.(delivery);

    expect(shown).toHaveBeenCalledWith(delivery);
    expect(stored()).toEqual([
      {
        id: expect.any(Number),
        from: 'principal',
        door: 'telegram',
        text: '[foto de ticket]',
        buttons: [],
        channelRef: null,
        at: AT.toISOString(),
      },
      {
        id: expect.any(Number),
        from: 'anomander',
        door: 'telegram',
        text: '¿Lo apunto?',
        buttons,
        channelRef: 'telegram:77',
        at: AT.toISOString(),
      },
    ]);
  });

  it('forgets every turn when cleared, as a confirmed forget does (R-23 AC6), and erases the stored conversation (DK-16 S5)', () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    turns.add('soy vegetariano', { text: 'Apuntado.' }, 'app');

    turns.clear();

    expect(turns.recent()).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it('records each answered input with its door, and nothing when there is no reply', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const handler = recordingTurns(
      turns,
      (text: string) => `[botón: ${text}]`,
      async (text: string): Promise<Reply | null> => (text === 'nada' ? null : { text: 'Hecho.' }),
      () => 'app',
    );

    await handler('nada');
    const reply = await handler('Sí');
    reply?.onDelivered?.({ channelRef: 'desktop:1', deliveredAt: AT.toISOString() });

    expect(
      stored().map(({ from, door, text, channelRef }) => ({ from, door, text, channelRef })),
    ).toEqual([
      { from: 'principal', door: 'app', text: '[botón: Sí]', channelRef: null },
      { from: 'anomander', door: 'app', text: 'Hecho.', channelRef: 'desktop:1' },
    ]);
  });

  it('records a message sent unasked as a turn with no principal part', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const sent: string[] = [];
    const notify = recordingNotices(turns, async (message) => {
      sent.push(message.text);
      message.onDelivered?.({ channelRef: 'telegram:9', deliveredAt: AT.toISOString() });
    });

    await notify({ text: 'Todavía no he podido leer el ticket.' });

    expect(sent).toEqual(['Todavía no he podido leer el ticket.']);
    expect(turns.recent()).toEqual([
      { principal: null, reply: 'Todavía no he podido leer el ticket.' },
    ]);
    expect(stored()).toMatchObject([
      { from: 'anomander', door: 'telegram', channelRef: 'telegram:9' },
    ]);
  });

  it('stores nothing for a message unasked that could not be sent', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const notify = recordingNotices(turns, async () => {
      throw new Error('Telegram is not configured');
    });

    await expect(notify({ text: 'Recordatorio' })).rejects.toThrow();

    expect(stored()).toEqual([]);
  });

  it('B50: stores nothing for a message unasked whose send ended without delivering it', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const notify = recordingNotices(turns, async () => {});

    await notify({ text: 'Recordatorio' });

    expect(stored()).toEqual([]);
  });

  it('DK-22: goes to Telegram and the connected app, calls onDelivered once and is kept once, as Telegram gave it', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const delivered: string[] = [];
    const pushed: string[] = [];
    const notify = recordingNotices(
      turns,
      async (message) => {
        message.onDelivered?.({ channelRef: 'telegram:9', deliveredAt: AT.toISOString() });
      },
      {
        connected: () => true,
        notify: async (message) => {
          pushed.push(message.text);
          message.onDelivered?.({ channelRef: 'desktop:1', deliveredAt: AT.toISOString() });
        },
      },
    );

    await notify({
      text: 'Recordatorio',
      onDelivered: (delivery) => delivered.push(delivery.channelRef),
    });

    expect(pushed).toEqual(['Recordatorio']);
    expect(delivered).toEqual(['telegram:9']);
    expect(stored()).toMatchObject([
      { from: 'anomander', door: 'telegram', channelRef: 'telegram:9' },
    ]);
  });

  it('DK-22: without Telegram, the connected app delivers it, and it is kept as the app gave it', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const notify = recordingNotices(
      turns,
      async () => {
        throw new Error('Telegram is not configured');
      },
      {
        connected: () => true,
        notify: async (message) => {
          message.onDelivered?.({ channelRef: 'desktop:1', deliveredAt: AT.toISOString() });
        },
      },
    );

    await notify({ text: 'Recordatorio' });

    expect(stored()).toMatchObject([{ from: 'anomander', door: 'app', channelRef: 'desktop:1' }]);
  });

  it('DK-22: when Telegram fails and the app got it, logs one fixed line without its words', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const notify = recordingNotices(
      turns,
      async () => {
        throw new Error('400: Bad Request: llamar a mamá');
      },
      {
        connected: () => true,
        notify: async (message) => {
          message.onDelivered?.({ channelRef: 'desktop:1', deliveredAt: AT.toISOString() });
        },
      },
      logger,
    );

    await notify({ text: 'Recordatorio: llamar a mamá.' });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('an unasked message reached the app but not Telegram');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('mamá');
  });

  it("DK-22: with no app connected and no Telegram, rejects with Telegram's failure and keeps nothing", async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const pushed = vi.fn(async () => {});
    const notify = recordingNotices(
      turns,
      async () => {
        throw new Error('Telegram is not configured');
      },
      { connected: () => false, notify: pushed },
    );

    await expect(notify({ text: 'Recordatorio' })).rejects.toThrow('Telegram is not configured');

    expect(pushed).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  it('a failure to store a turn never changes the reply, and is logged without its words', () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    db.exec('DROP TABLE conversation');

    expect(turns.add('mi secreto', { text: 'Hecho.' }, 'app')).toMatchObject({ text: 'Hecho.' });
    expect(turns.recent()).toEqual([]);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secreto');
    expect(logger.error).toHaveBeenCalled();
  });
});
