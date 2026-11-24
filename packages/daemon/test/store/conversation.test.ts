import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_LIMIT } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONVERSATION_RETENTION_DAYS,
  type ConversationMessage,
  conversationSince,
  deliveredAs,
  forgetConversation,
  forgetConversationBefore,
  recordMessages,
  storedConversation,
} from '../../src/store/conversation.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// DK-16 (docs/desktop-prd.md): the conversation with the principal, kept in the local database so
// it survives a restart, until it is erased or 90 days old.
const AT = '2026-11-24T10:00:00.000Z';
const DAY_MS = 86_400_000;

let scratch: string;
let path: string;
let db: Database.Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-conversation-'));
  path = join(scratch, 'anomander.db');
  db = openDatabase(path);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const principal = (text: string, at = AT): ConversationMessage => ({
  from: 'principal',
  door: 'app',
  text,
  buttons: [],
  channelRef: null,
  at,
});
const anomander = (text: string, at = AT): ConversationMessage => ({
  from: 'anomander',
  door: 'telegram',
  text,
  buttons: [],
  channelRef: null,
  at,
});

describe('the stored conversation (DK-16)', () => {
  it('S2: stores one row per message with who, door, text, buttons, channelRef and time, oldest first', () => {
    const ids = recordMessages(db, [
      principal('[foto de ticket] cena'),
      {
        ...anomander('¿Lo apunto?'),
        door: 'app',
        buttons: [
          { label: 'Sí', data: 'decision:3:0' },
          { label: 'Abrir', url: 'https://example.com' },
        ],
      },
    ]);
    const [, question] = ids;
    deliveredAs(db, question ?? 0, 'desktop:abc');
    recordMessages(db, [anomander('Recordatorio: llamar a Marta')]);

    expect(storedConversation(db, HISTORY_LIMIT)).toEqual([
      {
        id: ids[0],
        from: 'principal',
        door: 'app',
        text: '[foto de ticket] cena',
        buttons: [],
        channelRef: null,
        at: AT,
      },
      {
        id: question,
        from: 'anomander',
        door: 'app',
        text: '¿Lo apunto?',
        buttons: [
          { label: 'Sí', data: 'decision:3:0' },
          { label: 'Abrir', url: 'https://example.com' },
        ],
        channelRef: 'desktop:abc',
        at: AT,
      },
      {
        id: expect.any(Number),
        from: 'anomander',
        door: 'telegram',
        text: 'Recordatorio: llamar a Marta',
        buttons: [],
        channelRef: null,
        at: AT,
      },
    ]);
  });

  it('S4: returns only the latest messages up to the limit, still oldest first', () => {
    for (let i = 1; i <= 5; i++) recordMessages(db, [principal(`mensaje ${i}`)]);

    expect(storedConversation(db, 2).map(({ text }) => text)).toEqual(['mensaje 4', 'mensaje 5']);
  });

  it('ids are never reused after an erase', () => {
    const [first] = recordMessages(db, [principal('hola')]);
    forgetConversation(db);
    const [second] = recordMessages(db, [principal('hola otra vez')]);

    expect(second).toBeGreaterThan(first ?? 0);
  });

  it('S3: reads the messages sent since an instant, oldest first', () => {
    recordMessages(db, [principal('viejo', '2026-11-24T09:00:00.000Z')]);
    recordMessages(db, [principal('nuevo', '2026-11-24T09:45:00.000Z')]);

    expect(conversationSince(db, '2026-11-24T09:30:00.000Z').map(({ text }) => text)).toEqual([
      'nuevo',
    ]);
  });

  it('S5: erases every message for real, from the file and its WAL', () => {
    const marker = 'zorblaxconversationmarker';
    recordMessages(db, [principal(`mi clave es ${marker}`), anomander(`Apuntado ${marker}`)]);
    const onDisk = (): boolean =>
      [path, `${path}-wal`].some((file) => readFileSync(file).includes(marker));
    expect(onDisk()).toBe(true);

    expect(forgetConversation(db)).toBe(2);

    expect(storedConversation(db, HISTORY_LIMIT)).toEqual([]);
    expect(onDisk()).toBe(false);
  });

  it('S7: erases the messages older than 90 days, and only those', () => {
    const now = new Date(AT).getTime();
    const ago = (days: number) => new Date(now - days * DAY_MS).toISOString();
    recordMessages(db, [principal('antiguo', ago(91))]);
    recordMessages(db, [principal('reciente', ago(89))]);

    expect(forgetConversationBefore(db, ago(CONVERSATION_RETENTION_DAYS))).toBe(1);
    expect(storedConversation(db, HISTORY_LIMIT).map(({ text }) => text)).toEqual(['reciente']);
  });
});
