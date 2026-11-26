import { buttons, HISTORY_LIMIT, strings } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecentTurns, type RecentTurns } from '../../src/conversation/recent-turns.ts';
import { createForgetHistoryAnswerHandler } from '../../src/decisions/forget-history-decision.ts';
import { createForgetMemoryAnswerHandler } from '../../src/decisions/forget-memory-decision.ts';
import type { OpenDecision } from '../../src/decisions/types.ts';
import { storedConversation } from '../../src/store/conversation.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import {
  asOpenDecision,
  loadDecision,
  openForgetHistoryDecision,
  openForgetMemoryDecision,
} from '../../src/store/decisions.ts';
import { countActions, lastActionId, recordAction } from '../../src/store/history.ts';
import { listMemories, saveMemory } from '../../src/store/memory.ts';

// B55 (R-23 AC6, DK-14 AC4): when an erase fails the question stays open, so "Sí" can be pressed
// again. A "No" pressed after a "Sí" that erased part of it says so: never that nothing was.

const AT = new Date('2026-11-26T10:00:00Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let db: Database.Database;
let turns: RecentTurns;

beforeEach(() => {
  db = openDatabase(':memory:');
  applyMigrations(db);
  turns = createRecentTurns({ db, now: () => AT, logger });
});

afterEach(() => {
  db.close();
});

const now = () => AT;
const conversation = () => storedConversation(db, HISTORY_LIMIT).map(({ text }) => text);
const decisionOf = (id: number): OpenDecision => {
  const decision = asOpenDecision(loadDecision(db, id));
  if (decision === null) throw new Error(`decision ${id} is not open`);
  return decision;
};
/** A clear that fails the first time, as a failed WAL checkpoint would, then works. */
const failingOnce = () => {
  let failed = false;
  return () => {
    if (!failed) {
      failed = true;
      throw new Error('database is locked');
    }
    turns.clear();
  };
};

describe('forget_memory answer (R-23 AC6)', () => {
  const askToForget = () => {
    const id = saveMemory(db, {
      text: 'Es vegetariano',
      quote: 'soy vegetariano',
      said: true,
      confidence: 1,
      message: 'soy vegetariano',
      source: 'telegram:1',
      replaces: null,
      receivedAt: AT.toISOString(),
      now: AT.toISOString(),
    });
    turns.add('olvida que soy vegetariano', { text: '¿Olvido esto?\n· Es vegetariano' }, 'app');
    return openForgetMemoryDecision(db, {
      memoryIds: [id],
      question: strings.confirmForget([]),
      options: [buttons.yes, buttons.no],
      now: AT.toISOString(),
    });
  };

  it('B55: "No" after a "Sí" that erased the memory but not the conversation says part is gone', async () => {
    const decisionId = askToForget();
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: failingOnce() });

    await expect(
      answer({ db, decision: decisionOf(decisionId), option: buttons.yes, now }),
    ).rejects.toThrow('database is locked');
    // The question stays open; the memory is already erased.
    expect(listMemories(db)).toEqual([]);

    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });

    expect(reply.text).toBe(
      'Vale, no olvido nada más, pero parte ya estaba olvidado y no puedo recuperarlo.',
    );
    expect(loadDecision(db, decisionId)?.status).toBe('answered');
  });

  it('"No" with nothing erased still says it forgets nothing, and keeps it all', async () => {
    const decisionId = askToForget();
    const clear = vi.fn();
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: clear });

    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });

    expect(reply.text).toBe('Vale, no olvido nada.');
    expect(listMemories(db)).toEqual([
      { id: expect.any(Number), text: 'Es vegetariano', mode: 'declared' },
    ]);
    expect(clear).not.toHaveBeenCalled();
    expect(conversation()).toEqual([
      'olvida que soy vegetariano',
      '¿Olvido esto?\n· Es vegetariano',
    ]);
  });

  it('"Sí" pressed again after a failure finishes the erase and says it is forgotten', async () => {
    const decisionId = askToForget();
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: failingOnce() });
    await answer({ db, decision: decisionOf(decisionId), option: buttons.yes, now }).catch(
      () => {},
    );

    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.yes, now });

    expect(reply.text).toBe('Hecho, lo he olvidado.');
    expect(conversation()).toEqual([]);
  });
});

describe('forget_history answer (DK-14 AC4)', () => {
  const askToErase = () => {
    recordAction(db, {
      kind: 'connect',
      door: 'app',
      task: 'qué tengo mañana',
      outcome: 'answer',
      steps: null,
      calls: [],
      endedAt: AT.toISOString(),
    });
    turns.add('borra tu historial', { text: '¿Borro el historial?' }, 'app');
    const upToId = lastActionId(db);
    if (upToId === null) throw new Error('no action');
    return openForgetHistoryDecision(db, {
      upToId,
      question: strings.confirmForgetHistory(1),
      options: [buttons.yes, buttons.no],
      now: AT.toISOString(),
    });
  };

  it('B55: "No" after a "Sí" that erased the actions but not the conversation says part is gone', async () => {
    const decisionId = askToErase();
    const answer = createForgetHistoryAnswerHandler({ clearRecentTurns: failingOnce() });

    await expect(
      answer({ db, decision: decisionOf(decisionId), option: buttons.yes, now }),
    ).rejects.toThrow('database is locked');
    expect(countActions(db)).toBe(0);

    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });

    expect(reply.text).toBe(
      'Vale, no borro nada más, pero parte ya estaba borrado y no puedo recuperarlo.',
    );
  });

  it('B55: a "Sí" whose erase of the actions fails leaves the conversation, so "No" is true', async () => {
    const decisionId = askToErase();
    db.exec(
      "CREATE TRIGGER keep_actions BEFORE DELETE ON action_history BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
    );
    const answer = createForgetHistoryAnswerHandler({ clearRecentTurns: () => turns.clear() });

    await expect(
      answer({ db, decision: decisionOf(decisionId), option: buttons.yes, now }),
    ).rejects.toThrow('disk I/O error');
    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });

    expect(reply.text).toBe('Vale, no borro nada.');
    expect(countActions(db)).toBe(1);
    expect(conversation()).toEqual(['borra tu historial', '¿Borro el historial?']);
  });

  it('"No" with nothing erased still says it erases nothing', async () => {
    const decisionId = askToErase();
    const answer = createForgetHistoryAnswerHandler({ clearRecentTurns: vi.fn() });

    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });

    expect(reply.text).toBe('Vale, no borro nada.');
    expect(countActions(db)).toBe(1);
  });
});
