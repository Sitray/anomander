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
import { countActions, forgetAction, lastActionId, recordAction } from '../../src/store/history.ts';
import { forgetMemoryAndItsTurns, listMemories, saveMemory } from '../../src/store/memory.ts';

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
/** The rows of `actions` (PRD §13) of the proposal decision `id` asked. */
const actionsOf = (id: number) =>
  db
    .prepare<[number], { status: string; authorized_by: string; executed_at: string }>(
      `SELECT a.status, a.authorized_by, a.executed_at FROM actions a
       JOIN pending_decisions d ON d.proposal_id = a.proposal_id WHERE d.id = ? ORDER BY a.id`,
    )
    .all(id);
/** The payload of the proposal decision `id` asked. */
const payloadOf = (id: number): unknown =>
  JSON.parse(
    db
      .prepare<[number], { payload_json: string }>(
        `SELECT p.payload_json FROM proposals p
         JOIN pending_decisions d ON d.proposal_id = p.id WHERE d.id = ?`,
      )
      .get(id)?.payload_json ?? 'null',
  );
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

  it('B55: "Sí" failing before the memory is erased, then "No": S-31 and it is kept', async () => {
    const decisionId = askToForget();
    db.exec(
      "CREATE TRIGGER t BEFORE DELETE ON memory_texts BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
    );
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: () => turns.clear() });
    await expect(
      answer({ db, decision: decisionOf(decisionId), option: buttons.yes, now }),
    ).rejects.toThrow('disk I/O error');
    db.exec('DROP TRIGGER t');
    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });
    expect(reply.text).toBe('Vale, no olvido nada.');
    expect(listMemories(db)).toHaveLength(1);
  });

  it('B55: "Sí" failing when its answer is recorded, then "No": S-200', async () => {
    const decisionId = askToForget();
    db.exec(
      // B81: the answer is recorded by making the "Sí" started as an action executed.
      "CREATE TRIGGER t BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: () => turns.clear() });
    await expect(
      answer({ db, decision: decisionOf(decisionId), option: buttons.yes, now }),
    ).rejects.toThrow('disk full');
    db.exec('DROP TRIGGER t');
    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });
    expect(reply.text).toBe(
      'Vale, no olvido nada más, pero parte ya estaba olvidado y no puedo recuperarlo.',
    );
  });
});

describe('forget_memory answer after "Olvidar" in Memoria (B81)', () => {
  const ask = () => {
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
    const decisionId = openForgetMemoryDecision(db, {
      memoryIds: [id],
      question: strings.confirmForget([]),
      options: [buttons.yes, buttons.no],
      now: AT.toISOString(),
    });
    return { id, decisionId };
  };

  it('B81: "No" after the memory was forgotten in Memoria, with no "Sí" pressed, is S-31', async () => {
    const { id, decisionId } = ask();
    expect(forgetMemoryAndItsTurns(db, id)).toBe(true);
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: () => turns.clear() });

    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });

    expect(reply.text).toBe('Vale, no olvido nada.');
    expect(loadDecision(db, decisionId)?.status).toBe('answered');
    expect(actionsOf(decisionId)).toEqual([]);
  });

  it('"Sí" that works records one executed action, by the principal', async () => {
    const { decisionId } = ask();
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: () => turns.clear() });

    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.yes, now });

    expect(reply.text).toBe('Hecho, lo he olvidado.');
    expect(actionsOf(decisionId)).toEqual([
      { status: 'executed', authorized_by: 'principal', executed_at: AT.toISOString() },
    ]);
  });
});

describe('a "Sí" that cannot be recorded (B81)', () => {
  it('B81: erases nothing, so a "No" after it is S-31 and the memory is kept', async () => {
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
    turns.add('olvida que soy vegetariano', { text: '¿Olvido esto?' }, 'app');
    const decisionId = openForgetMemoryDecision(db, {
      memoryIds: [id],
      question: strings.confirmForget([]),
      options: [buttons.yes, buttons.no],
      now: AT.toISOString(),
    });
    db.exec(
      "CREATE TRIGGER t BEFORE INSERT ON actions BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: () => turns.clear() });

    await expect(
      answer({ db, decision: decisionOf(decisionId), option: buttons.yes, now }),
    ).rejects.toThrow('disk full');
    db.exec('DROP TRIGGER t');

    expect(listMemories(db)).toHaveLength(1);
    expect(conversation()).toEqual(['olvida que soy vegetariano', '¿Olvido esto?']);
    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });
    expect(reply.text).toBe('Vale, no olvido nada.');
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

  it('B55: "Sí" failing when its answer is recorded, after both erases, then "No": S-201', async () => {
    const decisionId = askToErase();
    db.exec(
      // B81: the answer is recorded by making the "Sí" started as an action executed.
      "CREATE TRIGGER t BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const answer = createForgetHistoryAnswerHandler({ clearRecentTurns: () => turns.clear() });
    await expect(
      answer({ db, decision: decisionOf(decisionId), option: buttons.yes, now }),
    ).rejects.toThrow('disk full');
    db.exec('DROP TRIGGER t');
    expect(conversation()).toEqual([]);
    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });
    expect(reply.text).toBe(
      'Vale, no borro nada más, pero parte ya estaba borrado y no puedo recuperarlo.',
    );
  });
});

describe('forget_history answer after "Olvidar" in Memoria (B81)', () => {
  it('B81: "No" after the actions were erased in Memoria, with no "Sí" pressed, is "Vale, no borro nada."', async () => {
    recordAction(db, {
      kind: 'connect',
      door: 'app',
      task: 'qué tengo mañana',
      outcome: 'answer',
      steps: null,
      calls: [],
      endedAt: AT.toISOString(),
    });
    const upToId = lastActionId(db);
    if (upToId === null) throw new Error('no action');
    const decisionId = openForgetHistoryDecision(db, {
      upToId,
      question: strings.confirmForgetHistory(1),
      options: [buttons.yes, buttons.no],
      now: AT.toISOString(),
    });
    expect(forgetAction(db, upToId)).toBe(true);
    const answer = createForgetHistoryAnswerHandler({ clearRecentTurns: () => turns.clear() });

    const reply = await answer({ db, decision: decisionOf(decisionId), option: buttons.no, now });

    expect(reply.text).toBe('Vale, no borro nada.');
    expect(actionsOf(decisionId)).toEqual([]);
  });
});

// B81 (R-23 AC6): each "Sí" is one action of its proposal: `failed` until it completes.
describe('the action a forget answer leaves (B81)', () => {
  const allActions = () =>
    db
      .prepare<[], { proposal_id: number; status: string }>(
        'SELECT proposal_id, status FROM actions ORDER BY id',
      )
      .all();
  const ask = () => {
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
    return {
      id,
      decision: openForgetMemoryDecision(db, {
        memoryIds: [id],
        question: strings.confirmForget([]),
        options: [buttons.yes, buttons.no],
        now: AT.toISOString(),
      }),
    };
  };

  it('a "Sí" that fails, then a "Sí" that works, leaves exactly one action, executed', async () => {
    const { decision } = ask();
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: failingOnce() });
    await expect(
      answer({ db, decision: decisionOf(decision), option: buttons.yes, now }),
    ).rejects.toThrow('database is locked');
    expect(allActions().map(({ status }) => status)).toEqual(['failed']);

    await answer({ db, decision: decisionOf(decision), option: buttons.yes, now });

    expect(allActions().map(({ status }) => status)).toEqual(['executed']);
  });

  it('a "Sí" that fails, then "No", leaves one failed action and says part is gone', async () => {
    const { decision } = ask();
    const answer = createForgetMemoryAnswerHandler({
      clearRecentTurns: () => {
        throw new Error('locked');
      },
    });
    await expect(
      answer({ db, decision: decisionOf(decision), option: buttons.yes, now }),
    ).rejects.toThrow();

    const reply = await answer({ db, decision: decisionOf(decision), option: buttons.no, now });

    expect(reply.text).toBe(strings.notForgottenAfterPart());
    expect(allActions().map(({ status }) => status)).toEqual(['failed']);
  });

  it('a plain "No" leaves no action', async () => {
    const { decision } = ask();
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: () => turns.clear() });

    await answer({ db, decision: decisionOf(decision), option: buttons.no, now });

    expect(allActions()).toEqual([]);
  });

  it('a "Sí" that failed before erasing, then "Olvidar" in Memoria, then "No": S-31', async () => {
    const { id, decision } = ask();
    db.exec("CREATE TRIGGER t BEFORE DELETE ON memory_texts BEGIN SELECT RAISE(ABORT, 'io'); END");
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: () => turns.clear() });
    await expect(
      answer({ db, decision: decisionOf(decision), option: buttons.yes, now }),
    ).rejects.toThrow('io');
    db.exec('DROP TRIGGER t');
    forgetMemoryAndItsTurns(db, id);

    const reply = await answer({ db, decision: decisionOf(decision), option: buttons.no, now });

    // B83: that "Sí" ran but forgot nothing; "Memoria" forgot it, so S-31 stays true.
    expect(reply.text).toBe('Vale, no olvido nada.');
    expect(allActions().map(({ status }) => status)).toEqual(['failed']);
    expect(payloadOf(decision)).toEqual({ memory_ids: [id] });
  });

  // B83: the "Sí" that forgot a memory says so in its proposal, in the erase's own transaction.
  it('a "Sí" that forgot the memory, then failed, records that it erased', async () => {
    const { id, decision } = ask();
    const answer = createForgetMemoryAnswerHandler({ clearRecentTurns: failingOnce() });
    await expect(
      answer({ db, decision: decisionOf(decision), option: buttons.yes, now }),
    ).rejects.toThrow('database is locked');

    expect(payloadOf(decision)).toEqual({ memory_ids: [id], erased: true });
    const reply = await answer({ db, decision: decisionOf(decision), option: buttons.no, now });
    expect(reply.text).toBe(strings.notForgottenAfterPart());
  });

  it('a "Sí" that failed before erasing the history, then "Olvidar" in Memoria, then "No": "Vale, no borro nada."', async () => {
    recordAction(db, {
      kind: 'connect',
      door: 'app',
      task: 'qué tengo mañana',
      outcome: 'answer',
      steps: null,
      calls: [],
      endedAt: AT.toISOString(),
    });
    const upToId = lastActionId(db);
    if (upToId === null) throw new Error('no action');
    const decision = openForgetHistoryDecision(db, {
      upToId,
      question: strings.confirmForgetHistory(1),
      options: [buttons.yes, buttons.no],
      now: AT.toISOString(),
    });
    db.exec(
      "CREATE TRIGGER t BEFORE DELETE ON action_history BEGIN SELECT RAISE(ABORT, 'io'); END",
    );
    const answer = createForgetHistoryAnswerHandler({ clearRecentTurns: () => turns.clear() });
    await expect(
      answer({ db, decision: decisionOf(decision), option: buttons.yes, now }),
    ).rejects.toThrow('io');
    db.exec('DROP TRIGGER t');
    expect(forgetAction(db, upToId)).toBe(true);

    const reply = await answer({ db, decision: decisionOf(decision), option: buttons.no, now });

    expect(reply.text).toBe('Vale, no borro nada.');
    expect(allActions().map(({ status }) => status)).toEqual(['failed']);
    expect(payloadOf(decision)).toEqual({ up_to_id: upToId });
  });

  it('a "Sí" that erased the history, then failed, records that it erased', async () => {
    recordAction(db, {
      kind: 'connect',
      door: 'app',
      task: 'qué tengo mañana',
      outcome: 'answer',
      steps: null,
      calls: [],
      endedAt: AT.toISOString(),
    });
    const upToId = lastActionId(db);
    if (upToId === null) throw new Error('no action');
    const decision = openForgetHistoryDecision(db, {
      upToId,
      question: strings.confirmForgetHistory(1),
      options: [buttons.yes, buttons.no],
      now: AT.toISOString(),
    });
    const answer = createForgetHistoryAnswerHandler({ clearRecentTurns: failingOnce() });
    await expect(
      answer({ db, decision: decisionOf(decision), option: buttons.yes, now }),
    ).rejects.toThrow('database is locked');

    expect(payloadOf(decision)).toEqual({ up_to_id: upToId, erased: true });
    const reply = await answer({ db, decision: decisionOf(decision), option: buttons.no, now });
    expect(reply.text).toBe(strings.historyNotForgottenAfterPart());
  });
});
