import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiBudget } from '../../src/budget/ai-budget.ts';
import { createReceiptExpenseCycle } from '../../src/expenses/receipt-expense.ts';
import { verbatimReplies } from '../../src/processor/reply-phraser.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// §16: the data folder, the database and the receipt images are readable by their owner only,
// whatever the umask allows.
let scratch: string;
let db: Database.Database | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-permissions-'));
});

afterEach(() => {
  db?.close();
  rmSync(scratch, { recursive: true, force: true });
});

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe('data permissions', () => {
  it('creates the data folder, the database and the receipt images for the owner only (§16)', async () => {
    const data = join(scratch, 'data');
    const dbPath = join(data, 'anomander.db');
    const inbox = join(data, 'inbox');
    const now = () => new Date('2026-10-30T10:00:00.000Z');
    db = openDatabase(dbPath);
    applyMigrations(db);
    // With the budget spent the receipt stays queued, so its image is still on disk (R-8 AC2).
    const cycle = createReceiptExpenseCycle({
      db,
      reader: async () => {
        throw new Error('the reader must not be called');
      },
      budget: createAiBudget({ db, limit: 0, timeZone: 'Europe/Madrid', now }),
      inboxDir: inbox,
      timeZone: 'Europe/Madrid',
      now,
      processorSource: 'processor:openai/gpt-4o',
      phraser: verbatimReplies,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await cycle.onReceipt({
      images: [{ mimeType: 'image/jpeg', load: async () => new Uint8Array([1]) }],
      caption: null,
      channelRef: 'telegram:7',
      receivedAt: now().toISOString(),
    });

    expect({
      data: modeOf(data),
      database: modeOf(dbPath),
      wal: modeOf(`${dbPath}-wal`),
      shm: modeOf(`${dbPath}-shm`),
      inbox: modeOf(inbox),
      receipt: modeOf(join(inbox, '1')),
      image: modeOf(join(inbox, '1', '1.jpg')),
    }).toEqual({
      data: 0o700,
      database: 0o600,
      wal: 0o600,
      shm: 0o600,
      inbox: 0o700,
      receipt: 0o700,
      image: 0o600,
    });
  });
});
