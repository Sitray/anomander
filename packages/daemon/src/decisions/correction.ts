import { isLiteralAmount } from '@anomander/core';
import { type PrincipalText, type Reply, strings } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { textValue, writtenIn } from '../expenses/declarations.ts';
import type { CorrectionInterpreter } from '../processor/correction-interpreter.ts';
import type { Logger } from '../processor/text-interpreter.ts';
import {
  answerDecision,
  awaitText,
  correctExpense,
  type ExpenseCorrection,
  pendingExpenseOf,
  registerByPrincipal,
} from '../store/decisions.ts';
import { listCategories, readExpense } from '../store/expenses.ts';
import { verifiedReply } from './register-expense-decision.ts';
import type { OpenDecision } from './types.ts';

// R-7 AC2: the principal's text corrects the expense of a decision (routed by R-17 AC2, AC3).

export interface Correction {
  decision: OpenDecision;
  message: PrincipalText;
}

/** Applies a correction text to its decision and returns what to tell the principal. */
export type CorrectionHandler = (correction: Correction) => Promise<Reply>;

export interface ExpenseCorrectionDeps {
  db: Database.Database;
  interpreter: CorrectionInterpreter;
  now: () => Date;
  logger: Logger;
}

/** The correction of a pending `register_expense` decision: the expense is corrected and registered. */
export const createExpenseCorrection = ({
  db,
  interpreter,
  now,
  logger,
}: ExpenseCorrectionDeps): CorrectionHandler => {
  /** Only what the principal actually wrote counts as their declaration (R-2 AC6, R-3 AC5). */
  const acceptedCorrection = async (
    text: string,
    expenseId: number,
    channelRef: string,
  ): Promise<ExpenseCorrection | 'failed'> => {
    const categories = listCategories(db);
    const stored = readExpense(db, expenseId);
    const interpretation = await interpreter({
      text,
      expense: {
        total_cents: stored.total_cents,
        merchant: stored.merchant,
        category: stored.category,
      },
      categories,
    });
    if (interpretation.kind === 'failed') return 'failed';
    if (interpretation.kind === 'invalid') return {};
    const value = (predicate: string) =>
      interpretation.inferences.find((inference) => inference.predicate === predicate)
        ?.value_json ?? null;

    const correction: ExpenseCorrection = {};
    const total = value('total');
    if (typeof total === 'number' && total > 0 && isLiteralAmount(text, total)) {
      correction.total_cents = total;
    } else if (total !== null) {
      logger.warn('corrected amount is not written in the message; ignored', { channelRef, total });
    }
    const merchant = textValue(value('merchant'));
    if (merchant !== null && writtenIn(text, merchant)) {
      correction.merchant = merchant;
    } else if (merchant !== null) {
      logger.info('corrected merchant not written in the message; ignored', { channelRef });
    }
    const category = textValue(value('category'))?.toLowerCase() ?? null;
    if (category !== null && writtenIn(text, category) && categories.includes(category)) {
      correction.category = category;
    } else if (category !== null) {
      // R-18 AC3 asks S-15 for a category that does not exist; that arrives in M4.
      logger.info('corrected category not written or not existing; ignored', {
        channelRef,
        category,
      });
    }
    return correction;
  };

  return async ({ decision, message }) => {
    const expenseId = pendingExpenseOf(db, decision);
    const correction = await acceptedCorrection(message.text, expenseId, message.channelRef);
    const at = now().toISOString();

    if (correction === 'failed') {
      // R-22 AC1: nothing was stored; the decision keeps waiting for the text to be sent again.
      logger.error('correction not handled: the processor failed', {
        channelRef: message.channelRef,
      });
      awaitText(db, decision.id, at);
      return { text: strings.processingFailed() };
    }
    if (Object.keys(correction).length === 0) {
      // Nothing usable: S-7 again, and the decision keeps waiting for the text (R-7 AC1).
      awaitText(db, decision.id, at);
      return { text: strings.askCorrection() };
    }

    // R-7 AC2: declare, supersede and refute, update the expense, and register it.
    const actionId = db.transaction(() => {
      const [answer = null] = correctExpense(db, {
        expenseId,
        correction,
        source: message.channelRef,
        receivedAt: message.receivedAt,
        now: at,
      });
      const registered = registerByPrincipal(db, {
        expenseId,
        proposalId: decision.proposal_id,
        source: message.channelRef,
        now: at,
      });
      answerDecision(db, decision.id, answer);
      return registered.actionId;
    })();

    // R-9 AC1: S-8 from the stored row, verbatim (R-21 AC3: only S-1, S-2, S-16, S-21 are phrased).
    const stored = readExpense(db, expenseId);
    const text = strings.corrected(stored.total_cents, stored.merchant ?? '', stored.category);
    return verifiedReply(db, actionId, text, now, logger);
  };
};
