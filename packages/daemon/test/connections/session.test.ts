import { type DoorReply, HISTORY_LIMIT } from '@anomander/protocol';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../../src/connections/connection.ts';
import {
  createConnectionSession,
  type Later,
  type TurnLock,
} from '../../src/connections/session.ts';
import { type ConnectionTasks, createConnectionTasks } from '../../src/connections/task.ts';
import { createRecentTurns } from '../../src/conversation/recent-turns.ts';
import { storedConversation } from '../../src/store/conversation.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { forgetMemoryAndItsTurns, saveMemory } from '../../src/store/memory.ts';

// B55 (DK-11, DK-16 AC1): what a task with connections asked in Telegram came to is sent there by
// itself, after the chat's turn. It is stored once it was delivered, with its reference, as a
// message sent unasked is; a send that fails stores nothing.

const AT = new Date('2026-11-26T10:00:00Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  applyMigrations(db);
});

afterEach(() => {
  db.close();
});

/** Every turn at once, each step counted only to wait for it. */
const lock = (): TurnLock & { settled: () => Promise<void> } => {
  const running = new Set<Promise<unknown>>();
  return {
    inTurn: (handler) => handler,
    track: (work) => {
      running.add(work);
      void work.finally(() => running.delete(work)).catch(() => {});
      return work;
    },
    settled: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
};
const answering = (text: string): ConnectionTasks => ({
  start: async () => ({ kind: 'answer', text }),
  answer: async () => ({ kind: 'answer', text }),
});
const stored = () =>
  storedConversation(db, HISTORY_LIMIT).map(({ from, door, text, channelRef }) => ({
    from,
    door,
    text,
    channelRef,
  }));

describe('connection session (DK-11)', () => {
  it('B55: in Telegram, an answer whose send fails is not stored', async () => {
    const turnLock = lock();
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const send = vi.fn(async (_: DoorReply) => {
      throw new Error('429 Too Many Requests');
    });
    const session = createConnectionSession({
      tasks: answering('Mañana tienes dentista a las 10.'),
      turnLock,
      turns,
      keep: () => {},
      send,
      logger,
    });

    expect(session.run('qué tengo mañana', 'telegram')).toBeNull();
    await turnLock.settled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stored()).toEqual([]);
  });

  it('B55: in Telegram, an answer is stored once delivered, with its reference', async () => {
    const turnLock = lock();
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const send = vi.fn(async (message: DoorReply) => {
      // Not stored before it was sent.
      expect(stored()).toEqual([]);
      message.onDelivered?.({ channelRef: 'telegram:42', deliveredAt: AT.toISOString() });
    });
    const session = createConnectionSession({
      tasks: answering('Mañana tienes dentista a las 10.'),
      turnLock,
      turns,
      keep: () => {},
      send,
      logger,
    });

    session.run('qué tengo mañana', 'telegram');
    await turnLock.settled();
    await vi.waitFor(() => expect(stored()).toHaveLength(2));

    expect(stored()).toEqual([
      {
        from: 'principal',
        door: 'telegram',
        text: '[conexiones] qué tengo mañana',
        channelRef: null,
      },
      {
        from: 'anomander',
        door: 'telegram',
        text: 'Mañana tienes dentista a las 10.',
        channelRef: 'telegram:42',
      },
    ]);
  });

  it('in Telegram, the answer is stored as it was sent: cut to what one message holds', async () => {
    const turnLock = lock();
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const sent: string[] = [];
    const session = createConnectionSession({
      tasks: answering('a'.repeat(5000)),
      turnLock,
      turns,
      keep: () => {},
      send: async (message) => {
        sent.push(message.text);
        message.onDelivered?.({ channelRef: 'telegram:43', deliveredAt: AT.toISOString() });
      },
      logger,
    });

    session.run('resume mi correo', 'telegram', true);
    await turnLock.settled();
    await vi.waitFor(() => expect(stored()).toHaveLength(1));

    expect(sent).toEqual(['a'.repeat(4096)]);
    expect(stored()).toEqual([
      { from: 'anomander', door: 'telegram', text: 'a'.repeat(4096), channelRef: 'telegram:43' },
    ]);
  });

  it('in the app, the answer is still stored in its turn, before the app gets it', async () => {
    const turnLock = lock();
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const session = createConnectionSession({
      tasks: answering('Mañana tienes dentista a las 10.'),
      turnLock,
      turns,
      keep: () => {},
      send: async () => {
        throw new Error('not for the app');
      },
      logger,
    });

    const reply = await (session.run('qué tengo mañana', 'app') as Later).later;

    expect(reply?.text).toBe('Mañana tienes dentista a las 10.');
    expect(stored()).toEqual([
      { from: 'principal', door: 'app', text: '[conexiones] qué tengo mañana', channelRef: null },
      {
        from: 'anomander',
        door: 'app',
        text: 'Mañana tienes dentista a las 10.',
        channelRef: null,
      },
    ]);
  });
});

// B81 (DK-16 AC5): the Telegram answer is stored after its turn, once delivered; an erase of the
// conversation between that turn and the delivery leaves it erased.
describe('connection session after an erase (B81)', () => {
  const session = (
    turns: ReturnType<typeof createRecentTurns>,
    send: (m: DoorReply) => Promise<void>,
  ) => {
    const turnLock = lock();
    return {
      turnLock,
      session: createConnectionSession({
        tasks: answering('Mañana tienes dentista a las 10.'),
        turnLock,
        turns,
        keep: () => {},
        send,
        logger,
      }),
    };
  };

  it('B81: in Telegram, an answer delivered after "Borrar conversación" is not stored', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    turns.add('23 € cena', { text: 'Apuntado.' }, 'telegram');
    const send = vi.fn(async (message: DoorReply) => {
      // Erased while the answer is on its way.
      turns.clear();
      message.onDelivered?.({ channelRef: 'telegram:44', deliveredAt: AT.toISOString() });
    });
    const { session: running, turnLock } = session(turns, send);

    running.run('qué tengo mañana', 'telegram');
    await turnLock.settled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stored()).toEqual([]);
    expect(turns.recent()).toEqual([]);
  });

  it('in Telegram, an answer is still stored when the erase came before its turn', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    turns.add('23 € cena', { text: 'Apuntado.' }, 'telegram');
    turns.clear();
    const send = vi.fn(async (message: DoorReply) => {
      message.onDelivered?.({ channelRef: 'telegram:45', deliveredAt: AT.toISOString() });
    });
    const { session: running, turnLock } = session(turns, send);

    running.run('qué tengo mañana', 'telegram');
    await turnLock.settled();
    await vi.waitFor(() => expect(stored()).toHaveLength(2));

    expect(stored()).toEqual([
      {
        from: 'principal',
        door: 'telegram',
        text: '[conexiones] qué tengo mañana',
        channelRef: null,
      },
      {
        from: 'anomander',
        door: 'telegram',
        text: 'Mañana tienes dentista a las 10.',
        channelRef: 'telegram:45',
      },
    ]);
  });
  /** A memory said in no stored turn. */
  const remember = (text: string, replaces: number | null) =>
    saveMemory(db, {
      text,
      quote: text,
      said: true,
      confidence: 1,
      message: text,
      source: 'telegram:1',
      replaces,
      receivedAt: AT.toISOString(),
      now: AT.toISOString(),
    });

  it('in Telegram, an answer is stored when a memory replaced meanwhile took no turn', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const old = remember('vivo en Zorbtown', null);
    const send = vi.fn(async (message: DoorReply) => {
      // Replaced while the answer is on its way: no stored turn holds its words.
      remember('vivo en Lisboa', old);
      message.onDelivered?.({ channelRef: 'telegram:46', deliveredAt: AT.toISOString() });
    });
    const { session: running, turnLock } = session(turns, send);

    running.run('qué tengo mañana', 'telegram');
    await turnLock.settled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stored().map(({ text }) => text)).toEqual([
      '[conexiones] qué tengo mañana',
      'Mañana tienes dentista a las 10.',
    ]);
  });

  it('in Telegram, an answer is stored when "Olvidar" in Memoria meanwhile erased no turn', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const forgotten = remember('Es vegetariano', null);
    const send = vi.fn(async (message: DoorReply) => {
      expect(forgetMemoryAndItsTurns(db, forgotten)).toBe(true);
      message.onDelivered?.({ channelRef: 'telegram:47', deliveredAt: AT.toISOString() });
    });
    const { session: running, turnLock } = session(turns, send);

    running.run('qué tengo mañana', 'telegram');
    await turnLock.settled();
    await vi.waitFor(() => expect(stored()).toHaveLength(2));

    expect(stored().map(({ channelRef }) => channelRef)).toEqual([null, 'telegram:47']);
  });

  it('in Telegram, an answer is not stored when a replaced memory took a turn meanwhile', async () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const old = remember('vivo en Zorbtown', null);
    turns.add('vivo en Zorbtown', { text: 'Tomo nota.' }, 'telegram');
    const send = vi.fn(async (message: DoorReply) => {
      remember('vivo en Lisboa', old);
      message.onDelivered?.({ channelRef: 'telegram:48', deliveredAt: AT.toISOString() });
    });
    const { session: running, turnLock } = session(turns, send);

    running.run('qué tengo mañana', 'telegram');
    await turnLock.settled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stored()).toEqual([]);
  });

  it('"Borrar conversación" counts as an erase even when the conversation is empty', () => {
    const turns = createRecentTurns({ db, now: () => AT, logger });
    const before = turns.erasures();

    turns.clear();

    expect(turns.erasures()).toBe(before + 1);
  });
});

describe('"Permitir siempre" whose grant cannot be stored (B67)', () => {
  it('nothing runs, and "Permitir siempre" pressed again stores it and runs the call once', async () => {
    const made: unknown[] = [];
    const notes: Connection = {
      name: 'notes',
      identity: 'id-notes',
      tools: [
        { name: 'create', description: 'c', inputSchema: { type: 'object', properties: {} } },
      ],
      readOnly: new Set(),
      call: async (_tool, args) => {
        made.push(args);
        return { text: 'ok', isError: false };
      },
    };
    const script = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'notes__create', arguments: { t: 'x' } }],
        stopReason: 'toolUse',
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Hecho.' }], stopReason: 'stop' },
    ] as unknown as AssistantMessage[];
    const tasks = createConnectionTasks({
      complete: async () => {
        const next = script.shift();
        if (next === undefined) throw new Error('script over');
        return next;
      },
      model: 'm',
      connections: async () => [notes],
      logger,
      newId: () => 'id-1',
    });
    let full = true;
    const granted: unknown[] = [];
    const session = createConnectionSession({
      tasks,
      turnLock: lock(),
      turns: createRecentTurns({ db, now: () => AT, logger }),
      keep: () => {},
      send: async () => {},
      grant: (call) => {
        if (full) throw new Error('disk full');
        granted.push(call);
      },
      logger,
    });
    const asked = await (session.run('apunta x', 'app') as Later).later;
    const always = asked?.buttons
      ?.flatMap((button) => ('data' in button ? [button.data] : []))
      .find((data) => data.endsWith(':always'));
    expect(always).toBe('connection:id-1:always');

    await expect((session.answer(always ?? '', 'app') as Later).later).rejects.toThrow('disk full');
    expect(made).toEqual([]);

    full = false;
    expect((await (session.answer(always ?? '', 'app') as Later).later)?.text).toBe('Hecho.');
    expect(granted).toEqual([{ server: 'notes', tool: 'create', identity: 'id-notes' }]);
    expect(made).toHaveLength(1);
    // Answered: a later press on it grants nothing.
    expect(session.answer(always ?? '', 'app')).toEqual({ text: expect.any(String) });
    expect(granted).toHaveLength(1);
  });
});
