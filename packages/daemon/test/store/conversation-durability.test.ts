import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_LIMIT } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecentTurns } from '../../src/conversation/recent-turns.ts';
import {
  CONVERSATION_RETENTION_DAYS,
  forgetConversationBefore,
  recordMessages,
  storedConversation,
} from '../../src/store/conversation.ts';
import { applyMigrations, MIGRATIONS_DIR, openDatabase } from '../../src/store/database.ts';
import { recordAction } from '../../src/store/history.ts';
import { saveMemory } from '../../src/store/memory.ts';

// DK-16: the stored conversation survives the 0009 migration and is erased for real.
const AT = new Date('2026-11-24T10:00:00.000Z');
const DAY = 86_400_000;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let scratch: string;
let path: string;
let db: Database.Database;
const onDisk = (marker: string): string[] =>
  [path, `${path}-wal`, `${path}-shm`].filter((file) => {
    try {
      return readFileSync(file).includes(marker);
    } catch {
      return false;
    }
  });

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-verify-conv-'));
  path = join(scratch, 'anomander.db');
});
afterEach(() => {
  db?.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('S2 migration 0009 over a database at 0008 with data', () => {
  it('backs up first, keeps the data, adds the empty table, and a second run applies nothing', () => {
    const upTo8 = join(scratch, 'm8');
    mkdirSync(upTo8);
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name < '0009')) {
      cpSync(join(MIGRATIONS_DIR, file), join(upTo8, file));
    }
    db = openDatabase(path);
    expect(applyMigrations(db, upTo8)).toBe(8);
    recordAction(db, {
      kind: 'screen',
      door: 'app',
      task: 'qué pone',
      outcome: 'answer',
      steps: null,
      calls: null,
      endedAt: AT.toISOString(),
    });

    expect(applyMigrations(db, MIGRATIONS_DIR, { now: () => AT })).toBe(1);
    expect(applyMigrations(db)).toBe(0);
    expect(readdirSync(scratch).filter((name) => name.includes('backup')).length).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM action_history').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM conversation').get()).toEqual({ n: 0 });
  });
});

describe('S5/S6 real erasure', () => {
  it('after clear, the text is in none of the db, -wal or -shm, even once new turns are stored after it', () => {
    db = openDatabase(path);
    applyMigrations(db);
    const turns = createRecentTurns({ db, now: () => AT, logger });
    for (let i = 0; i < 40; i++) {
      turns.add(`mi pin es zorbsecret${i}`, { text: `Apuntado zorbsecret${i}` }, 'app');
    }
    expect(onDisk('zorbsecret1')).not.toEqual([]);

    turns.clear();
    // What the forget answer stores right after the erase (the press and S-30).
    turns.add('[botón: Sí]', { text: 'Hecho, lo he olvidado.' }, 'telegram');

    expect(onDisk('zorbsecret')).toEqual([]);
    expect(turns.recent()).toEqual([{ principal: '[botón: Sí]', reply: 'Hecho, lo he olvidado.' }]);
  });
});

describe('R-23 AC3: a replaced memory takes the turns that hold its words with it', () => {
  const at = AT.toISOString();
  const capture = (text: string, quote: string, replaces: number | null) => ({
    text,
    quote,
    said: true,
    confidence: 1,
    message: quote,
    source: 'telegram:1',
    replaces,
    receivedAt: at,
    now: at,
  });
  const texts = () => storedConversation(db, HISTORY_LIMIT).map(({ text }) => text);

  it('R-23 AC3: a replacement erases the turns of the old fact, from the db, -wal and -shm, and keeps the rest', () => {
    db = openDatabase(path);
    applyMigrations(db);
    const turns = createRecentTurns({ db, now: () => AT, logger });
    turns.add('23 € cena', { text: 'Apuntado.' }, 'app');
    turns.add('Vivo en Zorbtown', { text: 'Tomo nota de que vives en zorbtown.' }, 'telegram');
    turns.add(null, { text: 'Recordatorio: llamar.' }, 'telegram');
    const old = saveMemory(db, capture('Vive en Zorbtown', 'Vivo en Zorbtown', null));
    expect(onDisk('Zorbtown')).not.toEqual([]);

    saveMemory(db, capture('Vive en Lisboa', 'ya vivo en Lisboa', old));

    expect(texts()).toEqual(['23 € cena', 'Apuntado.', 'Recordatorio: llamar.']);
    expect(onDisk('Zorbtown')).toEqual([]);
    expect(onDisk('zorbtown')).toEqual([]);
  });
});

describe('S7 retention', () => {
  it('keeps a message exactly 90 days old, erases one a millisecond older, from the file and WAL', () => {
    db = openDatabase(path);
    applyMigrations(db);
    const ago = (ms: number) => new Date(AT.getTime() - ms).toISOString();
    recordMessages(db, [
      {
        from: 'principal',
        door: 'app',
        text: 'zorbold',
        buttons: [],
        channelRef: null,
        at: ago(90 * DAY + 1),
      },
    ]);
    recordMessages(db, [
      {
        from: 'principal',
        door: 'app',
        text: 'edge',
        buttons: [],
        channelRef: null,
        at: ago(90 * DAY),
      },
    ]);
    expect(forgetConversationBefore(db, ago(CONVERSATION_RETENTION_DAYS * DAY))).toBe(1);
    expect(storedConversation(db, HISTORY_LIMIT).map(({ text }) => text)).toEqual(['edge']);
    expect(onDisk('zorbold')).toEqual([]);
  });
});
