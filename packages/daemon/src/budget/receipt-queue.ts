import type { Notify, Reply } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { Logger } from '../processor/text-interpreter.ts';
import { closeKeepReceiptDecisions, listWaitingReceipts } from '../retention/queued-receipts.ts';

// R-12 AC3: when the day changes in `TZ`, the receipts queued by the budget are read in arrival
// order, counting against the new day's cap. Reading goes through the receipt cycle.

export interface ReceiptQueueDeps {
  db: Database.Database;
  /** The receipt cycle's `readQueued`: `null` while the budget still refuses. */
  readQueued: (documentId: number) => Promise<Reply | null>;
  /** The reply to a receipt read from the queue goes to the principal unasked. */
  notify: Notify;
  now: () => Date;
  logger: Logger;
}

export interface ReceiptQueue {
  /** Reads waiting receipts until the queue is empty or the budget refuses. Returns how many. */
  drain(): Promise<number>;
}

export const createReceiptQueue = ({
  db,
  readQueued,
  notify,
  now,
  logger,
}: ReceiptQueueDeps): ReceiptQueue => {
  let draining: Promise<number> | null = null;

  const drainOnce = async (): Promise<number> => {
    let read = 0;
    for (const documentId of listWaitingReceipts(db, now().toISOString())) {
      let reply: Reply | null;
      try {
        reply = await readQueued(documentId);
      } catch (error) {
        logger.error('could not read a queued receipt', { documentId, error });
        continue;
      }
      // The budget refused: the rest waits for the next day, in the same order.
      if (reply === null) break;
      read += 1;
      // Read now, so S-13's question about keeping it is moot.
      closeKeepReceiptDecisions(db, documentId);
      try {
        await notify(reply);
      } catch (error) {
        logger.error('could not send the reply to a queued receipt', { documentId, error });
      }
    }
    return read;
  };

  return {
    // One drain at a time, so a receipt is never read twice.
    drain: () => {
      draining ??= drainOnce().finally(() => {
        draining = null;
      });
      return draining;
    },
  };
};
