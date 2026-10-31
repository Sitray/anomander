import { buttons, formatAmount, type Reply, strings, UNCATEGORIZED } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { ReplyPhraser } from '../processor/reply-phraser.ts';
import type { Logger } from '../processor/text-interpreter.ts';
import {
  answerDecision,
  awaitText,
  pendingExpenseOf,
  registerByPrincipal,
  rejectByPrincipal,
} from '../store/decisions.ts';
import { readExpense, recordReplyDelivery } from '../store/expenses.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-6 AC4 and R-7 AC1: the answers to a `register_expense` decision (S-3, S-4, S-6).

export interface RegisterExpenseDecisionDeps {
  /** Words S-1 and S-2 (R-21). */
  phraser: ReplyPhraser;
  logger: Logger;
}

/** R-9 AC2: the delivered reply becomes the observation that verifies the action. */
export const verifiedReply = (
  db: Database.Database,
  actionId: number,
  text: string,
  now: () => Date,
  logger: Logger,
): Reply => ({
  text,
  onDelivered: (delivery) => {
    if (!recordReplyDelivery(db, actionId, delivery, text, now().toISOString())) {
      logger.warn('reply delivery already recorded', { actionId });
    }
  },
});

export const createRegisterExpenseDecision =
  ({ phraser, logger }: RegisterExpenseDecisionDeps): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    const expenseId = pendingExpenseOf(db, decision);
    const at = now().toISOString();

    if (option === buttons.correct) {
      // R-7 AC1, R-17 AC3: S-7, verbatim, and the decision waits for the principal's text.
      awaitText(db, decision.id, at);
      return { text: strings.askCorrection() };
    }

    if (option === buttons.discard) {
      // R-6 AC4: the proposal is rejected and no expense becomes current. S-23 is verbatim.
      db.transaction(() => {
        rejectByPrincipal(db, expenseId, decision.proposal_id);
        answerDecision(db, decision.id, null);
      })();
      const stored = readExpense(db, expenseId);
      return { text: strings.discarded(stored.total_cents, stored.merchant ?? '') };
    }

    if (option !== buttons.register) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }
    // R-6 AC4: "Apuntar" registers with `authorized_by 'principal'` and a `confirmed` assertion.
    const source = `decision:${decision.id}:${decision.options.indexOf(option)}`;
    const { actionId } = db.transaction(() => {
      const registered = registerByPrincipal(db, {
        expenseId,
        proposalId: decision.proposal_id,
        source,
        now: at,
      });
      answerDecision(db, decision.id, registered.totalConfirmationId);
      return registered;
    })();

    // R-9 AC1: the reply comes from the stored row, worded by the phraser (R-21).
    const stored = readExpense(db, expenseId);
    const category = stored.category ?? UNCATEGORIZED;
    const text =
      stored.merchant === null
        ? await phraser({
            reference: strings.registeredNoMerchant(stored.total_cents, stored.category),
            facts: [formatAmount(stored.total_cents), category],
            message: option,
          })
        : await phraser({
            reference: strings.registered(stored.total_cents, stored.merchant, stored.category),
            facts: [formatAmount(stored.total_cents), stored.merchant, category],
            message: option,
          });
    return verifiedReply(db, actionId, text, now, logger);
  };
