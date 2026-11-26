import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
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

const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const NEWEST = Number.parseInt(MIGRATION_FILES.at(-1) ?? '', 10);

const BACKUP_NAME = /^anomander\.db\.backup-v(\d+)-\d{8}T\d{6}Z(-\d+)?$/;

const backups = (): string[] =>
  readdirSync(scratch)
    .filter((file) => BACKUP_NAME.test(file))
    .sort();

// A database as an older build left it: only the first `count` migrations, plus an expense.
const builtAt = (count: number, path = join(scratch, 'anomander.db')): void => {
  const older = mkdtempSync(join(tmpdir(), 'anomander-older-'));
  try {
    for (const file of MIGRATION_FILES.slice(0, count)) {
      copyFileSync(join(MIGRATIONS_DIR, file), join(older, file));
    }
    const db = openDatabase(path);
    try {
      applyMigrations(db, older);
      db.exec(`INSERT INTO entities (id, kind, name, created_at)
                 VALUES (100, 'merchant', 'Mercadona', '2026-01-02T10:00:00.000Z');
               INSERT INTO expenses (id, merchant_id, occurred_on, total_cents, mode, status, created_at)
                 VALUES (100, 100, '2026-01-02', 1234, 'declared', 'current', '2026-01-02T10:00:00.000Z');`);
    } finally {
      db.close();
    }
  } finally {
    rmSync(older, { recursive: true, force: true });
  }
};

const expense = (db: Database.Database): unknown =>
  db
    .prepare(
      `SELECT e.total_cents, e.occurred_on, m.name AS merchant
         FROM expenses e JOIN entities m ON m.id = e.merchant_id WHERE e.id = 100`,
    )
    .get();

const KEPT_EXPENSE = { total_cents: 1234, occurred_on: '2026-01-02', merchant: 'Mercadona' };

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
    // Nothing was pending, so nothing was backed up.
    expect(backups()).toEqual([]);
  });

  it('backs up nothing for a fresh database', () => {
    expect(applyMigrations(open())).toBe(MIGRATION_FILES.length);
    expect(backups()).toEqual([]);
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

describe('upgrading an existing database', () => {
  it.each([
    ['0001', 1],
    ['an intermediate version', 4],
  ])('upgrades a database from %s to the latest and keeps its data', (_label, count) => {
    builtAt(count);
    const db = open();
    expect(applyMigrations(db)).toBe(MIGRATION_FILES.length - count);
    expect((versions(db) as { version: string }[]).map((row) => row.version)).toEqual(
      MIGRATION_FILES.map((file) => file.replace(/\.sql$/, '')),
    );
    expect(expense(db)).toEqual(KEPT_EXPENSE);
    expect(names(db, 'table')).toContain('action_history');
    expect(names(db, 'table')).toContain('conversation');
  });

  it('first writes a dated backup, mode 600, of the database as it was', () => {
    builtAt(4);
    applyMigrations(open());

    const [backup, ...others] = backups();
    expect(others).toEqual([]);
    expect(backup).toMatch(/^anomander\.db\.backup-v4-\d{8}T\d{6}Z$/);
    const path = join(scratch, backup ?? '');
    // File modes are POSIX: on Windows the user profile's access list keeps the file private.
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const copy = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect((versions(copy) as { version: string }[]).map((row) => row.version)).toEqual(
        MIGRATION_FILES.slice(0, 4).map((file) => file.replace(/\.sql$/, '')),
      );
      expect(expense(copy)).toEqual(KEPT_EXPENSE);
    } finally {
      copy.close();
    }
  });

  it('keeps the three newest backups and deletes only files named as backups', () => {
    builtAt(4);
    const old = [
      'anomander.db.backup-v1-20200101T000000Z',
      'anomander.db.backup-v2-20200102T000000Z',
      'anomander.db.backup-v3-20200103T000000Z',
    ];
    const unrelated = [
      'anomander.db.before-import-20200101-000000',
      'anomander.db.backup-notes',
      'other.db.backup-v1-20200101T000000Z',
    ];
    for (const file of [...old, ...unrelated]) writeFileSync(join(scratch, file), 'x');

    applyMigrations(open());

    const kept = backups();
    expect(kept).toHaveLength(3);
    expect(kept.slice(0, 2)).toEqual(old.slice(1));
    expect(kept[2]).toMatch(/^anomander\.db\.backup-v4-/);
    for (const file of unrelated) expect(existsSync(join(scratch, file))).toBe(true);
  });

  it('deletes backups stamped in the future and never the one it has just written', () => {
    builtAt(4);
    // A clock that was once ahead left these.
    const future = [
      'anomander.db.backup-v1-20300101T000000Z',
      'anomander.db.backup-v2-20300102T000000Z',
      'anomander.db.backup-v3-20300103T000000Z',
    ];
    for (const file of future) writeFileSync(join(scratch, file), 'x');

    applyMigrations(open());

    // B52: the backup just written holds newer data than any of them.
    const kept = backups();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^anomander\.db\.backup-v4-/);
  });

  it('B52: deletes a backup stamped in the future before a real one', () => {
    builtAt(4);
    const real = [
      'anomander.db.backup-v2-20200102T000000Z',
      'anomander.db.backup-v3-20200103T000000Z',
    ];
    // A clock that was once ahead left this one.
    const future = 'anomander.db.backup-v1-20300101T000000Z';
    for (const file of [...real, future]) writeFileSync(join(scratch, file), 'x');

    applyMigrations(open());

    const kept = backups();
    expect(kept).toHaveLength(3);
    expect(kept.slice(0, 2)).toEqual(real);
    expect(kept[2]).toMatch(/^anomander\.db\.backup-v4-/);
  });

  // A read-only folder is POSIX: Windows ignores the read-only mark on a folder.
  it.skipIf(process.platform === 'win32')(
    'applies nothing when the backup cannot be written',
    () => {
      builtAt(4);
      const db = open();
      chmodSync(scratch, 0o500);
      try {
        expect(() => applyMigrations(db)).toThrow(/backup before migrations failed/);
      } finally {
        chmodSync(scratch, 0o700);
      }
      expect(versions(db)).toHaveLength(4);
      expect(names(db, 'table')).not.toContain('action_history');
      expect(names(db, 'table')).not.toContain('conversation');
      expect(backups()).toEqual([]);
    },
  );

  it('refuses a database newer than this build, naming both versions, and leaves it untouched', () => {
    const path = join(scratch, 'anomander.db');
    const first = open(path);
    applyMigrations(first);
    first
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES ('0099_future', 'x')")
      .run();
    first.close();
    opened = [];
    const bytes = readFileSync(path);

    const db = open(path);
    expect(() => applyMigrations(db)).toThrow(
      `the database is at migration version 99, newer than this build knows (${NEWEST})`,
    );
    db.close();
    opened = [];
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(backups()).toEqual([]);
  });

  it('does not call a version it does not know newer when it is lower', () => {
    const db = open();
    applyMigrations(db);
    db.prepare(
      "UPDATE schema_migrations SET version = '0003_renamed' WHERE version LIKE '0003%'",
    ).run();

    expect(() => applyMigrations(db)).toThrow(
      'the database records migration version 3, which this build does not know',
    );
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

// PRD §13: reminders and tasks (R-25) are the fourth SQL block of the data model.
describe('0005_reminders.sql', () => {
  it('equals the fourth SQL block of PRD §13', () => {
    const prd = readFileSync(resolve(import.meta.dirname, '../../../../PRD.md'), 'utf8');
    const section = prd.split('## 13. Data model')[1]?.split('\n## ')[0] ?? '';
    const block = section.split('```sql\n')[4]?.split('```')[0] ?? '';
    expect(block).toContain('CREATE TABLE reminders');
    expect(readFileSync(resolve(MIGRATIONS_DIR, '0005_reminders.sql'), 'utf8')).toBe(block);
  });
});

// PRD §13: the morning digest's sends (R-26 AC6) are the fifth SQL block of the data model.
describe('0006_digest_sends.sql', () => {
  it('equals the fifth SQL block of PRD §13', () => {
    const prd = readFileSync(resolve(import.meta.dirname, '../../../../PRD.md'), 'utf8');
    const section = prd.split('## 13. Data model')[1]?.split('\n## ')[0] ?? '';
    const block = section.split('```sql\n')[5]?.split('```')[0] ?? '';
    expect(block).toContain('CREATE TABLE digest_sends');
    expect(readFileSync(resolve(MIGRATIONS_DIR, '0006_digest_sends.sql'), 'utf8')).toBe(block);
  });
});
