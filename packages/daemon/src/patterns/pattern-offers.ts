import {
  buttons,
  type Delivery,
  decisionButtons,
  type Notify,
  type Reply,
  strings,
} from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { Logger } from '../processor/text-interpreter.ts';
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
  /** Opens and sends S-12 if the expense completes a pattern. Never throws. */
  offerAfter(expenseId: number): void;
}

export const createPatternOffers = ({
  db,
  now,
  notify,
  logger,
}: PatternOffersDeps): PatternOffers => ({
  offerAfter: (expenseId) => {
    let decisionId: number;
    let question: string;
    const options = [buttons.yes, buttons.no];
    try {
      // Found and opened at once (better-sqlite3 is synchronous), so a pattern is never open twice.
      const pattern = db.transaction(() => {
        const found = findPattern(db, expenseId);
        if (found === null) return null;
        const text = strings.proposePattern(strings.pattern(found.merchant, found.category));
        const id = openCreatePolicyDecision(db, {
          merchant: found.merchant,
          category: found.category,
          source: null,
          basis: { rule: 'R-13 AC2', expense_ids: found.expenseIds },
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

/** The reply, followed by S-12 once it is delivered, if the expense completes a pattern. */
export const thenOfferPattern = (
  reply: Reply,
  expenseId: number,
  patterns: PatternOffers | undefined,
): Reply =>
  patterns === undefined
    ? reply
    : {
        ...reply,
        onDelivered: (delivery) => {
          reply.onDelivered?.(delivery);
          patterns.offerAfter(expenseId);
        },
      };
