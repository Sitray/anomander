import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { todayIn } from '@anomander/core';
import { buttons, decisionButtons, type Notify, strings } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { Logger } from '../processor/text-interpreter.ts';
import { recordDecisionMessage } from '../store/receipts.ts';
import {
  discardReceipt,
  expireLooseInferences,
  expireOpenDecisions,
  listExpiredReceipts,
  listReceiptsToAsk,
  openKeepReceiptDecision,
} from './queued-receipts.ts';

// R-19, the internal "retain" operation: a deterministic job that only changes `status` columns,
// deletes temporary images and sends S-13 and S-14 (R-8 AC3, AC5).

const DAY = 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  db: Database.Database;
  /** `ANOMANDER_INBOX_DIR`: the images of a receipt live in `<inboxDir>/<document id>/`. */
  inboxDir: string;
  /** `TZ`: the dates in S-13 and S-14. */
  timeZone: string;
  now: () => Date;
  /** Sends S-13 and S-14 to the principal. */
  notify: Notify;
  logger: Logger;
}

export interface RetentionResult {
  inferencesExpired: number;
  decisionsExpired: number;
  receiptsDiscarded: number;
}

export interface Retention {
  /** R-19 AC1 to AC3. Running it twice in a row changes nothing the second time (AC4). */
  retain(): Promise<RetentionResult>;
  /** R-8 AC3 and AC5 alone, often enough to keep S-13's "lo borro en una hora". */
  watchQueuedReceipts(): Promise<void>;
}

export const createRetention = ({
  db,
  inboxDir,
  timeZone,
  now,
  notify,
  logger,
}: RetentionDeps): Retention => {
  /** `{fecha}` of S-13 and S-14: the day the principal sent it, in `TZ`. */
  const sentOn = (receivedAt: string) => todayIn(timeZone, new Date(receivedAt));

  /** R-8 AC5: never deleted unread without telling, so S-14 goes out first. */
  const discardExpired = async (): Promise<number> => {
    let discarded = 0;
    for (const receipt of listExpiredReceipts(db, now().toISOString())) {
      try {
        await notify({ text: strings.deletedUnreadReceipt(sentOn(receipt.received_at)) });
        await rm(join(inboxDir, String(receipt.id)), { recursive: true, force: true });
        if (discardReceipt(db, receipt.id, now().toISOString())) discarded += 1;
      } catch (error) {
        logger.error('could not discard an unread receipt; it stays queued', {
          documentId: receipt.id,
          error,
        });
      }
    }
    return discarded;
  };

  /** R-8 AC3: S-13 with "Sí" and "No", once, 1 hour before `keep_until`. */
  const askBeforeDeleting = async (): Promise<void> => {
    for (const receipt of listReceiptsToAsk(db, now())) {
      const question = strings.keepUnreadReceipt(sentOn(receipt.received_at));
      const options = [buttons.yes, buttons.no];
      const decisionId = openKeepReceiptDecision(db, {
        documentId: receipt.id,
        receivedAt: receipt.received_at,
        question,
        options,
        now: now().toISOString(),
      });
      try {
        await notify({
          text: question,
          buttons: decisionButtons(decisionId, options),
          onDelivered: (delivery) => {
            if (!recordDecisionMessage(db, decisionId, delivery.channelRef)) {
              logger.warn('decision message already recorded', { decisionId });
            }
          },
        });
      } catch (error) {
        // The receipt is still deleted only after S-14 (R-8 AC5).
        logger.error('could not send S-13', { documentId: receipt.id, error });
      }
    }
  };

  return {
    retain: async () => {
      const at = now().getTime();
      const decisionsExpired = expireOpenDecisions(db, new Date(at - 7 * DAY).toISOString());
      const inferencesExpired = expireLooseInferences(db, new Date(at - 30 * DAY).toISOString());
      const receiptsDiscarded = await discardExpired();
      return { inferencesExpired, decisionsExpired, receiptsDiscarded };
    },
    watchQueuedReceipts: async () => {
      await discardExpired();
      await askBeforeDeleting();
    },
  };
};
