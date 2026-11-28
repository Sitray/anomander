import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import {
  CONNECTION_TOOL_OPERATION,
  connectionToolGranted,
  connectionToolGrants,
  grantConnectionTool,
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

/** A row of that operation whose `conditions_json` is `stored`, as a damaged file would leave. */
const storeRaw = (stored: string): number =>
  Number(
    db
      .prepare('INSERT INTO permissions (operation, conditions_json, granted_at) VALUES (?, ?, ?)')
      .run(CONNECTION_TOOL_OPERATION, stored, NOW).lastInsertRowid,
  );

describe('a stored "Permitir siempre" that cannot be read (B67)', () => {
  it('is not granted, and the ones that can be read still are', () => {
    storeRaw('{"server":"notes","tool":"delete","identity":"id-notes"');
    const kept = grantConnectionTool(db, CREATE, 'app', NOW);

    expect(connectionToolGrants(db).map(({ id }) => id)).toEqual([kept]);
    expect(connectionToolGranted(db, CREATE)).toBe(true);
    expect(connectionToolGranted(db, { ...CREATE, tool: 'delete' })).toBe(false);
  });

  it('does not stop the grants of a changed server from being revoked', () => {
    storeRaw('not json');
    grantConnectionTool(db, CREATE, 'app', NOW);

    expect(revokeConnectionToolsNotIn(db, { notes: 'id-changed' }, NOW)).toBe(1);
    expect(connectionToolGranted(db, CREATE)).toBe(false);
    expect(connectionToolGrants(db)).toEqual([]);
  });
});
