import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, MIGRATIONS_DIR, openDatabase } from '../../src/store/database.ts';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let scratch: string;
let opened: Database.Database[];

const open = (path = join(scratch, 'anomander.db')): Database.Database => {
  const db = openDatabase(path);
  opened.push(db);
  return db;
};

const migrated = (): Database.Database => {
  const db = open();
  applyMigrations(db);
  return db;
};

const names = (db: Database.Database, type: string): string[] =>
  db
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type)
    .map((row) => row.name);

const versions = (db: Database.Database): unknown[] =>
  db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-store-'));
  opened = [];
});

afterEach(() => {
  for (const db of opened) db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates its folder and turns on WAL, foreign keys, recursive triggers and secure delete', () => {
    const path = join(scratch, 'nested', 'dir', 'anomander.db');
    const db = open(path);
    expect(existsSync(path)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('recursive_triggers', { simple: true })).toBe(1);
    expect(db.pragma('secure_delete', { simple: true })).toBe(1);
  });
});

describe('applyMigrations', () => {
  it('changes nothing when run twice', () => {
    const path = join(scratch, 'anomander.db');
    const first = open(path);
    applyMigrations(first);
    const before = versions(first);
    const counts = (db: Database.Database): unknown =>
      db
        .prepare(
          `SELECT (SELECT count(*) FROM entities) AS entities,
                  (SELECT count(*) FROM categories) AS categories,
                  (SELECT count(*) FROM matters) AS matters,
                  (SELECT count(*) FROM permissions) AS permissions`,
        )
        .get();
    const seeded = counts(first);
    first.close();
    opened = [];

    const second = open(path);
    expect(applyMigrations(second)).toBe(0);
    expect(versions(second)).toEqual(before);
    expect(counts(second)).toEqual(seeded);
  });

  it('rolls back a failing file and records no version for it', () => {
    const db = open();
    const migrationsDir = mkdtempSync(join(scratch, 'migrations-'));
    writeFileSync(join(migrationsDir, '0001_good.sql'), 'CREATE TABLE good (id INTEGER);');
    writeFileSync(
      join(migrationsDir, '0002_broken.sql'),
      'CREATE TABLE half (id INTEGER);\nINSERT INTO missing_table VALUES (1);',
    );

    expect(() => applyMigrations(db, migrationsDir)).toThrow(/0002_broken\.sql/);
    expect(names(db, 'table')).toEqual(['good', 'schema_migrations']);
    expect((versions(db) as { version: string }[]).map((row) => row.version)).toEqual([
      '0001_good',
    ]);
  });
});

describe('seed data', () => {
  it('holds the principal, the two categories, the expenses matter and the starting permission', () => {
    const db = migrated();

    const entities = db.prepare('SELECT id, kind, name, created_at FROM entities').all() as {
      created_at: string;
    }[];
    expect(entities).toEqual([
      { id: 1, kind: 'principal', name: 'principal', created_at: expect.stringMatching(ISO_UTC) },
    ]);

    const categories = db.prepare('SELECT name, created_at FROM categories ORDER BY id').all();
    expect(categories).toEqual([
      { name: 'supermercado', created_at: expect.stringMatching(ISO_UTC) },
      { name: 'restaurantes', created_at: expect.stringMatching(ISO_UTC) },
    ]);

    const matters = db.prepare('SELECT title, status, opened_at, closed_at FROM matters').all();
    expect(matters).toEqual([
      {
        title: 'Keep my expenses',
        status: 'active',
        opened_at: expect.stringMatching(ISO_UTC),
        closed_at: null,
      },
    ]);

    const permissions = db
      .prepare(
        'SELECT operation, conditions_json, limits_json, granted_at, expires_at, revoked_at FROM permissions',
      )
      .all();
    expect(permissions).toEqual([
      {
        operation: 'register_expense',
        conditions_json: '{"lines_sum_to_total": true, "category_basis": "policy"}',
        limits_json: null,
        granted_at: expect.stringMatching(ISO_UTC),
        expires_at: null,
        revoked_at: null,
      },
    ]);
  });
});

// R-7 AC3: no row in `assertions` is ever updated except `status`, or deleted.
const REWRITE = `(id, subject_type, predicate, value_json, mode, actor, source, status, created_at)
  VALUES (?, 'expense', 'total', '"rewritten"', 'observed', 'code', 'x', 'current', 'now')`;

describe('assertions ledger', () => {
  const insert = (db: Database.Database): number =>
    Number(
      db
        .prepare(
          `INSERT INTO assertions
             (subject_type, subject_id, predicate, value_json, mode, actor, source,
              basis_json, confidence, valid_at, expires_at, status, created_at)
           VALUES ('expense', 1, 'total', '1234', 'inferred', 'processor', 'telegram:1',
                   NULL, 0.9, NULL, NULL, 'current', '2026-10-30T10:00:00.000Z')`,
        )
        .run().lastInsertRowid,
    );

  const otherColumns: [string, unknown][] = [
    ['id', 999],
    ['subject_type', 'document'],
    ['subject_id', 42],
    ['predicate', 'merchant'],
    ['value_json', '"changed"'],
    ['mode', 'observed'],
    ['actor', 'code'],
    ['source', 'telegram:2'],
    ['basis_json', '{}'],
    ['confidence', 0.1],
    ['valid_at', '2026-10-01'],
    ['expires_at', '2027-01-01'],
    ['supersedes_id', 2],
    ['confirms_id', 2],
    ['created_at', '2026-10-31T10:00:00.000Z'],
  ];

  it('lets status change', () => {
    const db = migrated();
    const id = insert(db);
    db.prepare("UPDATE assertions SET status = 'refuted' WHERE id = ?").run(id);
    expect(db.prepare('SELECT status FROM assertions WHERE id = ?').get(id)).toEqual({
      status: 'refuted',
    });
  });

  it('aborts an update of any other column', () => {
    const db = migrated();
    const id = insert(db);
    insert(db);
    const before = db.prepare('SELECT * FROM assertions WHERE id = ?').get(id);
    for (const [column, value] of otherColumns) {
      expect(() =>
        db.prepare(`UPDATE assertions SET ${column} = ? WHERE id = ?`).run(value, id),
      ).toThrow('only assertions.status may change');
    }
    expect(db.prepare('SELECT * FROM assertions WHERE id = ?').get(id)).toEqual(before);
  });

  // REPLACE deletes the conflicting row internally, so it must hit the delete trigger too.
  it.each([
    ['a delete', 'DELETE FROM assertions WHERE id = ?'],
    ['REPLACE INTO', `REPLACE INTO assertions ${REWRITE}`],
    ['INSERT OR REPLACE', `INSERT OR REPLACE INTO assertions ${REWRITE}`],
  ])('aborts %s', (_label, sql) => {
    const db = migrated();
    const id = insert(db);
    const before = db.prepare('SELECT * FROM assertions WHERE id = ?').get(id);
    expect(() => db.prepare(sql).run(id)).toThrow('assertions are append-only');
    expect(db.prepare('SELECT * FROM assertions').all()).toEqual([before]);
  });
});

describe('supermarket_purchases view', () => {
  it('exposes exactly the dashboard columns', () => {
    const db = migrated();
    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('supermarket_purchases')")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(['producto', 'cantidad', 'precio_cents', 'comercio', 'fecha', 'modo']);
  });
});

// PRD §13: the daily AI budget (R-12) is the second SQL block of the data model.
describe('0003_ai_budget.sql', () => {
  it('equals the second SQL block of PRD §13', () => {
    const prd = readFileSync(resolve(import.meta.dirname, '../../../../PRD.md'), 'utf8');
    const section = prd.split('## 13. Data model')[1]?.split('\n## ')[0] ?? '';
    const block = section.split('```sql\n')[2]?.split('```')[0] ?? '';
    expect(block).toContain('CREATE TABLE ai_usage');
    expect(readFileSync(resolve(MIGRATIONS_DIR, '0003_ai_budget.sql'), 'utf8')).toBe(block);
  });
});

// PRD §13: conversation memory (R-23) is the third SQL block of the data model.
describe('0004_conversation_memory.sql', () => {
  it('equals the third SQL block of PRD §13', () => {
    const prd = readFileSync(resolve(import.meta.dirname, '../../../../PRD.md'), 'utf8');
    const section = prd.split('## 13. Data model')[1]?.split('\n## ')[0] ?? '';
    const block = section.split('```sql\n')[3]?.split('```')[0] ?? '';
    expect(block).toContain('CREATE TABLE memory_texts');
    expect(readFileSync(resolve(MIGRATIONS_DIR, '0004_conversation_memory.sql'), 'utf8')).toBe(
      block,
    );
  });
});
