import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrincipalReceipt, Reply } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiBudget } from '../../src/budget/ai-budget.ts';
import { createReceiptQueue } from '../../src/budget/receipt-queue.ts';
import { createReceiptExpenseCycle } from '../../src/expenses/receipt-expense.ts';
import type { ReceiptReader, ReceiptReaderInput } from '../../src/processor/receipt-reader.ts';
import { verbatimReplies } from '../../src/processor/reply-phraser.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// R-12 AC2 and AC3, R-8 AC2: past the cap a receipt waits with its images; the next day the
// queue is read in arrival order against the new day's cap.
const TZ = 'Europe/Madrid';
const S10 = 'He llegado al límite diario de IA. Leeré este ticket mañana.';
const S5 = 'No he podido leer el ticket. ¿Me escribes el total y el comercio?';

let scratch: string;
let inbox: string;
let db: Database.Database;
let clock: Date;
let readerInputs: ReceiptReaderInput[];
const now = () => clock;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const reader: ReceiptReader = async (input) => {
  readerInputs.push(input);
  return { kind: 'unreadable', reason: 'test' };
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-queue-'));
  inbox = join(scratch, 'inbox');
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
  clock = new Date('2026-10-30T10:00:00.000Z');
  readerInputs = [];
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const receipt = (caption: string, receivedAt: string): PrincipalReceipt => ({
  images: [{ mimeType: 'image/png', load: async () => new Uint8Array([1, 2, 3]) }],
  caption,
  channelRef: `telegram:${caption}`,
  receivedAt,
});

const documents = () =>
  db
    .prepare(
      'SELECT id, received_at, status, keep_until, image_deleted_at FROM documents ORDER BY id',
    )
    .all() as {
    id: number;
    received_at: string;
    status: string;
    keep_until: string | null;
    image_deleted_at: string | null;
  }[];

describe('R-12 queued receipts', () => {
  it('AC2: past the cap the processor is not called, the receipt waits 24 h with its images and S-10 goes out once', async () => {
    const budget = createAiBudget({ db, limit: 2, timeZone: TZ, now });
    budget.tryConsume();
    budget.tryConsume();
    const cycle = createReceiptExpenseCycle({
      db,
      reader,
      budget,
      inboxDir: inbox,
      timeZone: TZ,
      now,
      processorSource: 'processor:openai/gpt-4o',
      phraser: verbatimReplies,
      logger,
    });

    const replies = [
      await cycle.onReceipt(receipt('A', '2026-10-30T09:59:58.000Z')),
      await cycle.onReceipt(receipt('B', '2026-10-30T09:59:59.000Z')),
    ];

    expect(replies).toEqual([{ text: S10 }, null]);
    expect(readerInputs).toEqual([]);
    expect(documents()).toEqual([
      {
        id: 1,
        received_at: '2026-10-30T09:59:58.000Z',
        status: 'queued',
        keep_until: '2026-10-31T09:59:58.000Z',
        image_deleted_at: null,
      },
      {
        id: 2,
        received_at: '2026-10-30T09:59:59.000Z',
        status: 'queued',
        keep_until: '2026-10-31T09:59:59.000Z',
        image_deleted_at: null,
      },
    ]);
    expect(readdirSync(join(inbox, '1'))).toEqual(['1.png']);
    expect(readdirSync(join(inbox, '2'))).toEqual(['1.png']);
  });

  it('AC3: on the next day in TZ the queue is read in arrival order, counting against the new cap', async () => {
    const budget = createAiBudget({ db, limit: 2, timeZone: TZ, now });
    budget.tryConsume();
    budget.tryConsume();
    const cycle = createReceiptExpenseCycle({
      db,
      reader,
      budget,
      inboxDir: inbox,
      timeZone: TZ,
      now,
      processorSource: 'processor:openai/gpt-4o',
      phraser: verbatimReplies,
      logger,
    });
    // Received out of order: arrival is `received_at`, not the order the rows were stored in.
    await cycle.onReceipt(receipt('B', '2026-10-30T09:00:02.000Z'));
    await cycle.onReceipt(receipt('A', '2026-10-30T09:00:01.000Z'));
    await cycle.onReceipt(receipt('C', '2026-10-30T09:00:03.000Z'));
    const sent: Reply[] = [];
    const queue = createReceiptQueue({
      db,
      readQueued: cycle.readQueued,
      notify: async (reply) => {
        sent.push(reply);
      },
      now,
      logger,
    });

    // Still 30 October in Madrid: the cap holds and nothing is read.
    clock = new Date('2026-10-30T22:59:00.000Z');
    await queue.drain();
    expect(readerInputs).toEqual([]);

    // 23:00 UTC is midnight in Madrid.
    clock = new Date('2026-10-30T23:00:00.000Z');
    await queue.drain();

    expect(readerInputs.map((input) => input.caption)).toEqual(['A', 'B']);
    expect(readerInputs[0]?.today).toBe('2026-10-31');
    expect(sent.map((reply) => reply.text)).toEqual([S5, S5]);
    expect(documents().map(({ status }) => status)).toEqual(['unreadable', 'unreadable', 'queued']);
    expect(existsSync(join(inbox, '1'))).toBe(false);
    expect(existsSync(join(inbox, '2'))).toBe(false);
    expect(readdirSync(join(inbox, '3'))).toEqual(['1.png']);
  });
});
