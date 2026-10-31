import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import {
  forgetMemories,
  listMemories,
  type MemoryCapture,
  memoriesForPrompt,
  saveMemory,
} from '../../src/store/memory.ts';

const NOW = '2026-10-31T10:00:00.000Z';

let scratch: string;
let path: string;
let db: Database.Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-memory-'));
  path = join(scratch, 'anomander.db');
  db = openDatabase(path);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const capture = (overrides: Partial<MemoryCapture> = {}): MemoryCapture => ({
  text: 'Es vegetariano',
  quote: 'soy vegetariano',
  said: true,
  confidence: 0.9,
  message: 'Por cierto, SOY   vegetariano desde hace años',
  source: 'telegram:7',
  replaces: null,
  receivedAt: NOW,
  now: NOW,
  ...overrides,
});

const assertion = (id: number): unknown =>
  db
    .prepare(
      `SELECT subject_type, subject_id, predicate, value_json, mode, actor, source, basis_json,
         confidence, status, supersedes_id FROM assertions WHERE id = ?`,
    )
    .get(id);

const textOf = (id: number): unknown =>
  db.prepare('SELECT text, quote FROM memory_texts WHERE assertion_id = ?').get(id);

const searched = (term: string): number[] =>
  db
    .prepare<[string], { rowid: number }>(
      'SELECT rowid FROM memory_search WHERE memory_search MATCH ? ORDER BY rowid',
    )
    .all(term)
    .map((row) => row.rowid);

describe('saveMemory', () => {
  // R-23 AC2: declared only when said and quoted from the message; the text stays out of the ledger.
  it('stores a declared or an inferred memory about the principal, its text in memory_texts', () => {
    const declared = saveMemory(db, capture());
    const inferred = saveMemory(
      db,
      capture({ text: 'Le gusta cocinar', quote: 'cocino cada noche', source: 'telegram:8' }),
    );

    const principal = { subject_type: 'principal', subject_id: 1, predicate: 'memory' };
    const noText = { value_json: '{"text_in":"memory_texts"}', status: 'current' };
    expect(assertion(declared)).toEqual({
      ...principal,
      ...noText,
      mode: 'declared',
      actor: 'principal',
      source: 'telegram:7',
      basis_json: null,
      confidence: null,
      supersedes_id: null,
    });
    expect(assertion(inferred)).toEqual({
      ...principal,
      ...noText,
      mode: 'inferred',
      actor: 'processor',
      source: 'telegram:8',
      basis_json: '{"quote_in":"memory_texts"}',
      confidence: 0.9,
      supersedes_id: null,
    });
    expect(textOf(declared)).toEqual({ text: 'Es vegetariano', quote: 'soy vegetariano' });
    expect(textOf(inferred)).toEqual({ text: 'Le gusta cocinar', quote: 'cocino cada noche' });
    expect(listMemories(db)).toEqual([
      { id: declared, text: 'Es vegetariano', mode: 'declared' },
      { id: inferred, text: 'Le gusta cocinar', mode: 'inferred' },
    ]);
  });

  // R-23 AC3: "ya no soy vegetariano" refutes the memory it replaces and erases its text.
  it('refutes the memory a new one replaces, erases its text and links it with supersedes_id', () => {
    const old = saveMemory(db, capture());
    const replacement = saveMemory(
      db,
      capture({
        text: 'Ya no es vegetariano',
        quote: 'ya no soy vegetariano',
        message: 'Ya no soy vegetariano',
        replaces: old,
      }),
    );

    expect(assertion(old)).toMatchObject({ status: 'refuted', supersedes_id: null });
    expect(assertion(replacement)).toMatchObject({ status: 'current', supersedes_id: old });
    expect(listMemories(db)).toEqual([
      { id: replacement, text: 'Ya no es vegetariano', mode: 'declared' },
    ]);
    expect(db.prepare('SELECT assertion_id FROM memory_texts').all()).toEqual([
      { assertion_id: replacement },
    ]);
  });
});

describe('memoriesForPrompt', () => {
  // R-23 AC4: all current memories up to 50; beyond that, the best FTS5 matches for the message.
  it('gives every memory up to 50, then only those the message matches', () => {
    const vegetarian = saveMemory(db, capture());
    for (let n = 1; n < 50; n += 1) {
      saveMemory(db, capture({ text: `Tiene la llave ${n}`, quote: 'llave', message: 'llave' }));
    }
    expect(memoriesForPrompt(db, '¿Qué ceno hoy?')).toHaveLength(50);

    saveMemory(db, capture({ text: 'Vive en Valencia', quote: 'Valencia', message: 'Valencia' }));
    // FTS5 syntax in the message is only ever searched for as plain words.
    const message = '¿Qué ceno, siendo VEGETARIANO? "NEAR( * AND -';
    expect(memoriesForPrompt(db, message)).toEqual([
      { id: vegetarian, text: 'Es vegetariano', mode: 'declared' },
    ]);
  });
});

describe('forgetMemories', () => {
  // R-23 AC6, AC7: the text leaves memory_texts, the FTS5 index, the database file and its WAL.
  it('erases the text for real and keeps the assertion as expired', () => {
    const marker = 'zorblaxquuxmarker';
    const kept = saveMemory(db, capture());
    const forgotten = saveMemory(
      db,
      capture({
        text: `Su clave es ${marker}`,
        quote: `${marker}quote`,
        message: `mi clave es ${marker}quote`,
      }),
    );
    expect(searched(marker)).toEqual([forgotten]);
    const onDisk = (): boolean =>
      [path, `${path}-wal`].some((file) => readFileSync(file).includes(marker));
    expect(onDisk()).toBe(true);

    expect(forgetMemories(db, [forgotten, 9999])).toEqual([forgotten]);

    expect(listMemories(db)).toEqual([{ id: kept, text: 'Es vegetariano', mode: 'declared' }]);
    expect(searched(marker)).toEqual([]);
    expect(textOf(forgotten)).toBeUndefined();
    expect(assertion(forgotten)).toMatchObject({ status: 'expired', mode: 'declared' });
    expect(onDisk()).toBe(false);
  });
});
