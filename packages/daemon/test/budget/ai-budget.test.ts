import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { budgeted, createAiBudget } from '../../src/budget/ai-budget.ts';
import { createPiAiReplyPhraser } from '../../src/processor/reply-phraser.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// R-12: a per-day cap of processor calls in `TZ`, persisted in SQLite.
const TZ = 'Europe/Madrid';

let scratch: string;
let db: Database.Database;
let clock: Date;
const now = () => clock;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-budget-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
  // 22:30 UTC on 30 October is 23:30 in Madrid (UTC+1).
  clock = new Date('2026-10-30T22:30:00.000Z');
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const usage = () =>
  db.prepare('SELECT day, calls, limit_notified FROM ai_usage ORDER BY day').all();

describe('R-12 daily AI budget', () => {
  it('AC1: counts calls per day in TZ and refuses past the cap until the day changes there', () => {
    const budget = createAiBudget({ db, limit: 2, timeZone: TZ, now });

    expect([budget.tryConsume(), budget.tryConsume(), budget.tryConsume()]).toEqual([
      true,
      true,
      false,
    ]);
    // 23:30 UTC is already 31 October in Madrid: a new day, a new cap.
    clock = new Date('2026-10-30T23:30:00.000Z');
    expect(budget.tryConsume()).toBe(true);

    expect(usage()).toEqual([
      { day: '2026-10-30', calls: 2, limit_notified: 0 },
      { day: '2026-10-31', calls: 1, limit_notified: 0 },
    ]);
  });

  it('AC2: the limit notice is claimed once a day', () => {
    const budget = createAiBudget({ db, limit: 0, timeZone: TZ, now });

    expect(budget.tryConsume()).toBe(false);
    expect([budget.claimLimitNotice(), budget.claimLimitNotice()]).toEqual([true, false]);
    clock = new Date('2026-10-31T10:00:00.000Z');
    expect(budget.claimLimitNotice()).toBe(true);
  });

  it('survives a restart: the count lives in the database', () => {
    createAiBudget({ db, limit: 1, timeZone: TZ, now }).tryConsume();

    expect(createAiBudget({ db, limit: 1, timeZone: TZ, now }).tryConsume()).toBe(false);
  });
});

describe('R-21 AC4: phrasing counts against the budget', () => {
  const REFERENCE = 'Apuntado: 23,00 € en Mercadona (restaurantes).';
  const PHRASED = '¡Hecho! 23,00 € en Mercadona, en restaurantes.';
  const answer = {
    role: 'assistant',
    content: [{ type: 'text', text: PHRASED }],
    stopReason: 'stop',
  } as unknown as AssistantMessage;

  it('phrases while the budget lasts, then sends the §12 string without calling the processor', async () => {
    const budget = createAiBudget({ db, limit: 1, timeZone: TZ, now });
    const calls: Context[] = [];
    const phrase = createPiAiReplyPhraser({
      complete: budgeted(async (_model: string, context: Context) => {
        calls.push(context);
        return answer;
      }, budget),
      model: 'openai/gpt-4o-mini',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const request = {
      reference: REFERENCE,
      facts: ['23,00 €', 'Mercadona', 'restaurantes'],
      message: '23 € cena',
    };

    expect(await phrase(request)).toBe(PHRASED);
    expect(await phrase(request)).toBe(REFERENCE);
    expect(calls).toHaveLength(1);
    expect(usage()).toEqual([{ day: '2026-10-30', calls: 1, limit_notified: 0 }]);
  });
});
