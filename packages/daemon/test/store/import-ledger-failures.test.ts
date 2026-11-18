import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DK-12 AC3: a failure while the files are moved leaves the app's ledger where it was. `renameSync`
// is made to fail on the move it is told to.

const plan = vi.hoisted(() => ({
  failInto: null as string | null,
  failAsideOf: null as string | null,
  probe: null as null | (() => void),
  calls: [] as string[],
}));

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  const renameSync = (from: string, to: string) => {
    plan.calls.push(`${basename(from)} -> ${basename(to)}`);
    plan.probe?.();
    if (plan.failInto !== null && to === plan.failInto && from.endsWith('.import')) {
      const e = new Error('simulated') as Error & { code: string };
      e.code = 'EXDEV';
      throw e;
    }
    if (plan.failAsideOf !== null && from === plan.failAsideOf) {
      const e = new Error('simulated') as Error & { code: string };
      e.code = 'EPERM';
      throw e;
    }
    return real.renameSync(from, to);
  };
  return { ...real, default: { ...real, renameSync }, renameSync };
});

const { acquireDaemonLock, DaemonAlreadyRunningError } = await import(
  '../../src/store/daemon-lock.ts'
);
const { applyMigrations, openDatabase } = await import('../../src/store/database.ts');
const { importLedger } = await import('../../src/store/import-ledger.ts');

let scratch: string;
let data: string;
let own: string;
let source: string;

const ledger = (path: string, expenses: number): void => {
  const db = openDatabase(path);
  applyMigrations(db);
  for (let i = 0; i < expenses; i += 1) {
    db.prepare(
      `INSERT INTO expenses (occurred_on, total_cents, mode, status, created_at)
       VALUES ('2026-09-01', ?, 'declared', 'current', '2026-09-01T10:00:00.000Z')`,
    ).run(100 + i);
  }
  db.close();
};

const all = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((n) => !n.endsWith('.lock'))
      .sort()
      .map((n) => [
        n,
        `${(statSync(join(dir, n)).mode & 0o777).toString(8)}:${readFileSync(join(dir, n)).toString('base64')}`,
      ]),
  );

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-import-failures-'));
  data = join(scratch, 'data');
  mkdirSync(data, { mode: 0o700 });
  own = join(data, 'anomander.db');
  mkdirSync(join(scratch, 'docker'));
  source = join(scratch, 'docker', 'anomander.db');
  ledger(source, 2);
  plan.failInto = null;
  plan.failAsideOf = null;
  plan.probe = null;
  plan.calls = [];
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('failure after the move aside', () => {
  it('puts the app’s ledger back as it was when the copy cannot be moved into place', () => {
    ledger(own, 0);
    const before = all(data);
    plan.failInto = own;
    expect(() =>
      importLedger(source, own, { now: () => new Date('2026-11-18T10:20:30Z') }),
    ).toThrow('simulated');
    expect(all(data)).toEqual(before);
  });

  it('leaves the app’s ledger as it was when it cannot be moved aside', () => {
    ledger(own, 0);
    const before = all(data);
    plan.failAsideOf = own;
    expect(() => importLedger(source, own)).toThrow('simulated');
    expect(all(data)).toEqual(before);
  });

  it('holds the daemon’s lock while it moves the files', () => {
    ledger(own, 0);
    const seen: string[] = [];
    plan.probe = () => {
      try {
        acquireDaemonLock(own).release();
        seen.push('free');
      } catch (e) {
        seen.push(e instanceof DaemonAlreadyRunningError ? 'held' : String(e));
      }
    };
    expect(importLedger(source, own)).toEqual({ kind: 'imported' });
    plan.probe = null;
    expect(seen.every((s) => s === 'held')).toBe(true);
    // And lets it go after.
    acquireDaemonLock(own).release();
  });
});
