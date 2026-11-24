import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import {
  type ActionRecord,
  forgetHistory,
  HISTORY_PROMPT_DAYS,
  HISTORY_PROMPT_LIMIT,
  historyForPrompt,
  lastActionId,
  recordAction,
} from '../../src/store/history.ts';

// DK-14 (docs/desktop-prd.md): the persistent, local history of what ANOMANDER did.
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-20T18:30:00.000Z');
const DAY_MS = 86_400_000;

let scratch: string;
let path: string;
let db: Database.Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-history-'));
  path = join(scratch, 'anomander.db');
  db = openDatabase(path);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const action = (overrides: Partial<ActionRecord> = {}): ActionRecord => ({
  kind: 'computer',
  door: 'app',
  task: 'abre Notas',
  outcome: 'done',
  steps: 3,
  calls: null,
  endedAt: NOW.toISOString(),
  ...overrides,
});

const rows = () => db.prepare('SELECT * FROM action_history ORDER BY id').all();

describe('action history (DK-14)', () => {
  it('AC2: stores each ended action with its words, how it ended, its steps or calls, its door and when, in a file only its owner reads', () => {
    recordAction(db, action());
    recordAction(
      db,
      action({
        kind: 'connect',
        door: 'telegram',
        task: 'qué tengo mañana',
        outcome: 'answer',
        steps: null,
        calls: [
          { server: 'calendar', tool: 'events', allowed: true },
          { server: 'notes', tool: 'create', allowed: false },
        ],
      }),
    );
    recordAction(db, action({ kind: 'screen', task: '¿qué ves?', outcome: 'answer', steps: null }));

    expect(rows()).toEqual([
      {
        id: 1,
        kind: 'computer',
        door: 'app',
        task: 'abre Notas',
        outcome: 'done',
        steps: 3,
        calls_json: null,
        ended_at: NOW.toISOString(),
      },
      {
        id: 2,
        kind: 'connect',
        door: 'telegram',
        task: 'qué tengo mañana',
        outcome: 'answer',
        steps: null,
        calls_json:
          '[{"server":"calendar","tool":"events","allowed":true},{"server":"notes","tool":"create","allowed":false}]',
        ended_at: NOW.toISOString(),
      },
      {
        id: 3,
        kind: 'screen',
        door: 'app',
        task: '¿qué ves?',
        outcome: 'answer',
        steps: null,
        calls_json: null,
        ended_at: NOW.toISOString(),
      },
    ]);
    // File modes are POSIX: on Windows the user profile's access list keeps the file private.
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('AC2: refuses a kind or a door it does not know', () => {
    expect(() => recordAction(db, action({ kind: 'mail' as 'computer' }))).toThrow(/CHECK/);
    expect(() => recordAction(db, action({ door: 'web' as 'app' }))).toThrow(/CHECK/);
    expect(rows()).toEqual([]);
  });

  it('AC3: the prompt gets at most the 20 latest of the last 7 days, oldest first, with when they ended in TZ', () => {
    // One older than the 7 days, then 25 within them, one hour apart.
    recordAction(
      db,
      action({ task: 'antigua', endedAt: new Date(NOW.getTime() - 8 * DAY_MS).toISOString() }),
    );
    for (let index = 25; index >= 1; index -= 1) {
      const endedAt = new Date(NOW.getTime() - index * 3_600_000).toISOString();
      recordAction(db, action({ task: `tarea ${index}`, endedAt }));
    }
    recordAction(
      db,
      action({
        kind: 'connect',
        task: 'última',
        outcome: 'stopped',
        steps: null,
        calls: [{ server: 'notes', tool: 'create', allowed: false }],
        endedAt: NOW.toISOString(),
      }),
    );

    const history = historyForPrompt(db, TZ, NOW);

    expect(HISTORY_PROMPT_LIMIT).toBe(20);
    expect(HISTORY_PROMPT_DAYS).toBe(7);
    expect(history).toHaveLength(20);
    expect(history.map(({ task }) => task)).toEqual([
      ...Array.from({ length: 19 }, (_, index) => `tarea ${19 - index}`),
      'última',
    ]);
    // 18:30 UTC is 19:30 in Madrid; 17:30 UTC is 18:30.
    expect(history.at(-2)).toEqual({
      when: '2026-11-20 18:30',
      what: 'computer',
      door: 'app',
      task: 'tarea 1',
      outcome: 'done',
      steps: 3,
    });
    expect(history.at(-1)).toEqual({
      when: '2026-11-20 19:30',
      what: 'connect',
      door: 'app',
      task: 'última',
      outcome: 'stopped',
      calls: [{ server: 'notes', tool: 'create', allowed: false }],
    });
  });

  it('AC3: an action older than 7 days never reaches the prompt', () => {
    recordAction(db, action({ endedAt: new Date(NOW.getTime() - 7 * DAY_MS - 1).toISOString() }));
    expect(historyForPrompt(db, TZ, NOW)).toEqual([]);
  });

  it('AC4: erases every row up to the one it names, and the erased words survive in no file', () => {
    recordAction(db, action({ task: 'secreto viejo uno' }));
    recordAction(db, action({ task: 'secreto viejo dos' }));
    const upTo = lastActionId(db);
    recordAction(db, action({ task: 'después' }));

    expect(upTo).toBe(2);
    expect(forgetHistory(db, upTo ?? 0)).toBe(2);

    expect((rows() as { task: string }[]).map(({ task }) => task)).toEqual(['después']);
    db.close();
    for (const file of [path, `${path}-wal`]) {
      let bytes = '';
      try {
        bytes = readFileSync(file).toString('latin1');
      } catch {
        // No WAL left is fine.
      }
      expect(bytes).not.toContain('secreto viejo');
    }
    db = openDatabase(path);
  });

  it('AC4: knows when there is nothing to erase', () => {
    expect(lastActionId(db)).toBeNull();
    expect(forgetHistory(db, 10)).toBe(0);
  });
});

describe('migration 0008 (verifier probes)', () => {
  it('upgrades a database at 0007, keeps its mode 600, and a second run applies nothing', async () => {
    const { cpSync, mkdirSync, readdirSync } = await import('node:fs');
    const { MIGRATIONS_DIR } = await import('../../src/store/database.ts');
    const upTo7 = join(scratch, 'm7');
    mkdirSync(upTo7);
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name < '0008')) {
      cpSync(join(MIGRATIONS_DIR, file), join(upTo7, file));
    }
    const oldPath = join(scratch, 'old.db');
    const old = openDatabase(oldPath);
    expect(applyMigrations(old, upTo7)).toBe(7);
    // 0008 and every migration after it.
    expect(applyMigrations(old)).toBe(
      readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name >= '0008').length,
    );
    expect(applyMigrations(old)).toBe(0);
    recordAction(old, action());
    expect(old.prepare('SELECT count(*) AS n FROM action_history').get()).toEqual({ n: 1 });
    old.close();
    if (process.platform !== 'win32') expect(statSync(oldPath).mode & 0o777).toBe(0o600);
  });

  it('never reuses an id a full erase freed: AC4 erases up to an id', () => {
    recordAction(db, action());
    recordAction(db, action());
    forgetHistory(db, 2);
    recordAction(db, action({ task: 'después' }));
    expect(lastActionId(db)).toBeGreaterThan(2);
  });
});
