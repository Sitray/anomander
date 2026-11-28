import type { AssistantMessage } from '@earendil-works/pi-ai';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../../src/connections/connection.ts';
import { createConnectionSession, type TurnLock } from '../../src/connections/session.ts';
import { createConnectionTasks } from '../../src/connections/task.ts';
import { createRecentTurns } from '../../src/conversation/recent-turns.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let db: Database.Database;
beforeEach(() => {
  db = openDatabase(':memory:');
  applyMigrations(db);
});
afterEach(() => db.close());
const lock = (): TurnLock => ({ inTurn: (h) => h, track: (w) => w });
const GONE = { text: 'Esa petición ya no está pendiente.' };
type R = { text: string; buttons?: { data: string }[] };
const out = async (r: unknown): Promise<unknown> =>
  r !== null && typeof r === 'object' && 'later' in r
    ? await (r as { later: Promise<unknown> }).later
    : r;

const make = () => {
  const made: unknown[] = [];
  const notes: Connection = {
    name: 'notes',
    identity: 'id-notes',
    tools: [{ name: 'create', description: 'c', inputSchema: { type: 'object', properties: {} } }],
    readOnly: new Set(),
    call: async (_t, a) => {
      made.push(a);
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
      const n = script.shift();
      if (!n) throw new Error('over');
      return n;
    },
    model: 'm',
    connections: async () => [notes],
    logger,
    newId: () => 'id-1',
  });
  const state = { fail: true };
  const grant = vi.fn(() => {
    if (state.fail) throw new Error('disk full');
  });
  const session = createConnectionSession({
    tasks,
    turnLock: lock(),
    turns: createRecentTurns({ db, now: () => new Date(), logger }),
    keep: () => {},
    send: async () => {},
    grant,
    logger,
  });
  return { made, grant, state, session };
};
const ALWAYS = 'connection:id-1:always';
const ALLOW = 'connection:id-1:allow';

describe('recheck B67 session', () => {
  it('failed store, then "Permitir siempre" again: stored once, run once, Hecho.; later press gone', async () => {
    const { made, grant, state, session } = make();
    const asked = (await out(session.run('apunta x', 'app'))) as R;
    expect(asked.buttons?.map((b) => b.data)).toContain(ALWAYS);
    await expect(out(session.answer(ALWAYS, 'app'))).rejects.toThrow('disk full');
    expect(made).toEqual([]);
    state.fail = false;
    expect(await out(session.answer(ALWAYS, 'app'))).toMatchObject({ text: 'Hecho.' });
    expect(grant).toHaveBeenCalledTimes(2);
    expect(grant.mock.results.filter((r) => r.type === 'return')).toHaveLength(1);
    expect(made).toHaveLength(1);
    expect(await out(session.answer(ALWAYS, 'app'))).toMatchObject(GONE);
    expect(await out(session.answer(ALLOW, 'app'))).toMatchObject(GONE);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(made).toHaveLength(1);
  });

  it('failed store, then "Sí": run once, nothing stored; then "Permitir siempre" stores nothing', async () => {
    const { made, grant, session } = make();
    await out(session.run('apunta x', 'app'));
    await expect(out(session.answer(ALWAYS, 'app'))).rejects.toThrow('disk full');
    expect(await out(session.answer(ALLOW, 'app'))).toMatchObject({ text: 'Hecho.' });
    expect(made).toHaveLength(1);
    expect(await out(session.answer(ALWAYS, 'app'))).toMatchObject(GONE);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('two presses at once run once', async () => {
    const { made, grant, state, session } = make();
    state.fail = false;
    await out(session.run('apunta x', 'app'));
    const a = session.answer(ALWAYS, 'app');
    const b = session.answer(ALWAYS, 'app');
    const c = session.answer(ALLOW, 'app');
    const res = await Promise.all([out(a), out(b), out(c)]);
    expect(res.filter((r) => (r as { text?: string })?.text === 'Hecho.')).toHaveLength(1);
    expect(made).toHaveLength(1);
    expect(grant).toHaveBeenCalledTimes(1);
  });
});
