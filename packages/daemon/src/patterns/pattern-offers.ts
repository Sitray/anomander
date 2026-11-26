import {
  buttons,
  type Delivery,
  decisionButtons,
  type Notify,
  type Reply,
  strings,
} from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { Logger } from '../processor/ports.ts';
import { findPattern, openCreatePolicyDecision } from '../store/policies.ts';
import { recordDecisionMessage } from '../store/receipts.ts';

// R-13 AC2: code, never the processor, notices a pattern right after a registration that can
// complete one (a text expense, "Apuntar" or a correction), and offers it with S-12 as its own
// message, sent unasked once the registration reply was delivered.

export interface PatternOffersDeps {
  db: Database.Database;
  now: () => Date;
  /** Sends S-12 to the principal. */
  notify: Notify;
  logger: Logger;
}

export interface PatternOffers {
  /**
   * Opens and sends S-12 if the expense completes a pattern. Never throws. `ledBy` is the
   * proposal of the "Deshacer" under the correction that led to it (R-7 AC9), kept in the offer's
   * basis as `led_by_proposal_id` so that "Deshacer" withdraws it (B79).
   */
  offerAfter(expenseId: number, ledBy?: number): void;
}

/** Whether the question of a proposal was answered, as a used "Deshacer" is. */
const wasUsed = (db: Database.Database, proposalId: number): boolean =>
  db
    .prepare<[number], { used: number }>(
      `SELECT EXISTS (SELECT 1 FROM pending_decisions WHERE proposal_id = ? AND status = 'answered') AS used`,
    )
    .get(proposalId)?.used === 1;

export const createPatternOffers = ({
  db,
  now,
  notify,
  logger,
}: PatternOffersDeps): PatternOffers => ({
  offerAfter: (expenseId, ledBy) => {
    let decisionId: number;
    let question: string;
    const options = [buttons.yes, buttons.no];
    try {
      // Found and opened at once (better-sqlite3 is synchronous), so a pattern is never open twice.
      const pattern = db.transaction(() => {
        // B79: a correction whose "Deshacer" was already used leads to no offer, even when its
        // reply's delivery is handled after that "Deshacer" (which withdraws only offers open then).
        if (ledBy !== undefined && wasUsed(db, ledBy)) return null;
        const found = findPattern(db, expenseId);
        if (found === null) return null;
        const text = strings.proposePattern(strings.pattern(found.merchant, found.category));
        const id = openCreatePolicyDecision(db, {
          merchant: found.merchant,
          category: found.category,
          source: null,
          basis: {
            rule: 'R-13 AC2',
            expense_ids: found.expenseIds,
            ...(ledBy === undefined ? {} : { led_by_proposal_id: ledBy }),
          },
          question: text,
          options,
          now: now().toISOString(),
        });
        return { id, text };
      })();
      if (pattern === null) return;
      decisionId = pattern.id;
      question = pattern.text;
    } catch (error) {
      logger.error('pattern not checked', { expenseId, reason: (error as Error).message });
      return;
    }
    notify({
      text: question,
      buttons: decisionButtons(decisionId, options),
      onDelivered: (delivery: Delivery) => {
        if (!recordDecisionMessage(db, decisionId, delivery.channelRef)) {
          logger.warn('decision message already recorded', { decisionId });
        }
      },
    }).catch((error: unknown) => {
      // The decision stays open until it expires (R-19), so the pattern is not offered meanwhile.
      logger.error('could not send S-12', { decisionId, error });
    });
  },
});

/**
 * The reply, followed by S-12 once it is delivered, if the expense completes a pattern; `ledBy`
 * names the correction's "Deshacer" proposal when the reply is a correction's (B79).
 */
export const thenOfferPattern = (
  reply: Reply,
  expenseId: number,
  patterns: PatternOffers | undefined,
  ledBy?: number,
): Reply =>
  patterns === undefined
    ? reply
    : {
        ...reply,
        onDelivered: (delivery) => {
          reply.onDelivered?.(delivery);
          patterns.offerAfter(expenseId, ledBy);
        },
      };
