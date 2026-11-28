import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import {
  CONNECTION_TOOL_OPERATION,
  connectionToolGranted,
  connectionToolGrants,
  grantConnectionTool,
  revokeConnectionTool,
  revokeConnectionToolsNotIn,
} from '../../src/store/permissions.ts';

// DK-24, B67: a "Permitir siempre" whose stored conditions cannot be read is never one in force,
// and it stops neither the others nor the revoking of the ones of a changed server.
let db: Database.Database;
const NOW = '2026-11-28T10:00:00.000Z';
const CREATE = { server: 'notes', tool: 'create', identity: 'id-notes' };

beforeEach(() => {
  db = openDatabase(':memory:');
  applyMigrations(db);
});

afterEach(() => {
  db.close();
});

/** A row of `operation` whose `conditions_json` is `stored`, as a damaged file would leave. */
const storeRaw = (stored: string, operation = CONNECTION_TOOL_OPERATION): number =>
  Number(
    db
      .prepare('INSERT INTO permissions (operation, conditions_json, granted_at) VALUES (?, ?, ?)')
      .run(operation, stored, NOW).lastInsertRowid,
  );

/** Conditions that are not JSON, or not a server, a tool and an identity as texts. */
const UNREADABLE = [
  'true',
  'null',
  '0',
  '"notes"',
  '[]',
  '{}',
  '["notes","create","id-notes"]',
  '{"server":"notes","tool":"create"}',
  '{"server":"notes","tool":"create","identity":1}',
  '{"server":"notes","tool":"create","identity":null}',
  '{"server":["notes"],"tool":"create","identity":"id-notes"}',
  '',
  ' ',
  'not json',
  '{"server":"notes","tool":"create","identity":"id-notes"',
  '{"server":"notes","tool":"create","identity":"id-notes"} trailing',
  "{'server':'notes','tool':'create','identity':'id-notes'}",
  '['.repeat(200_000),
];

describe('a stored "Permitir siempre" that cannot be read (B67)', () => {
  it('is not granted, whatever it holds, and the ones that can be read still are', () => {
    for (const stored of UNREADABLE) storeRaw(stored);
    expect(connectionToolGranted(db, CREATE)).toBe(false);
    expect(connectionToolGrants(db)).toEqual([]);

    const kept = grantConnectionTool(db, CREATE, 'app', NOW);

    expect(connectionToolGrants(db).map(({ id }) => id)).toEqual([kept]);
    expect(connectionToolGranted(db, CREATE)).toBe(true);
  });

  it('is told by its id only, each time the grants are read', () => {
    const broken = storeRaw('{"server":"notes","tool":"create","identity":"secret-token"');
    const shapeless = storeRaw('{"server":"notes"}');
    grantConnectionTool(db, CREATE, 'app', NOW);
    const unreadable = vi.fn();

    connectionToolGrants(db, unreadable);
    revokeConnectionToolsNotIn(db, { notes: 'id-notes' }, NOW, unreadable);

    expect(unreadable.mock.calls).toEqual([[shapeless], [broken], [shapeless], [broken]]);
  });

  it('does not stop the grants of a changed server from being revoked, and leaves none usable', () => {
    for (const stored of UNREADABLE) storeRaw(stored);
    grantConnectionTool(db, CREATE, 'app', NOW);
    grantConnectionTool(db, { ...CREATE, tool: 'delete' }, 'app', NOW);
    grantConnectionTool(db, { server: 'mail', tool: 'send', identity: 'id-mail' }, 'telegram', NOW);

    expect(revokeConnectionToolsNotIn(db, { notes: 'id-changed', mail: 'id-mail' }, NOW)).toBe(2);
    expect(connectionToolGranted(db, CREATE)).toBe(false);
    expect(connectionToolGrants(db).map(({ server, tool }) => [server, tool])).toEqual([
      ['mail', 'send'],
    ]);
    // A later "Permitir siempre" for the changed server is a new grant.
    grantConnectionTool(db, { ...CREATE, identity: 'id-changed' }, 'app', NOW);
    expect(connectionToolGranted(db, { ...CREATE, identity: 'id-changed' })).toBe(true);
  });
});

describe('a stored "Permitir siempre" that can be read (DK-24)', () => {
  it('grants only its server, tool, identity and operation; other fields change nothing', () => {
    storeRaw(JSON.stringify({ ...CREATE, server: 'mail' }));
    storeRaw(JSON.stringify({ ...CREATE, tool: 'delete' }));
    storeRaw(JSON.stringify({ ...CREATE, identity: 'other' }));
    storeRaw(JSON.stringify(CREATE), 'send_weekly_summary');
    expect(connectionToolGranted(db, CREATE)).toBe(false);

    const extra = storeRaw(JSON.stringify({ ...CREATE, door: 'app', granted: false }));
    expect(connectionToolGranted(db, CREATE)).toBe(true);

    revokeConnectionTool(db, extra, NOW);
    expect(connectionToolGranted(db, CREATE)).toBe(false);
  });
});
