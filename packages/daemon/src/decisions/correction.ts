import { isCalendarDate, isLiteralAmount, todayIn } from '@anomander/core';
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
import { quotedFrom } from '../store/memory.ts';
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
  /** `TZ`: today is computed there, as for text expenses (R-2 AC7). */
  timeZone: string;
  now: () => Date;
  logger: Logger;
}

/** The correction of a pending `register_expense` decision: the expense is corrected and registered. */
export const createExpenseCorrection = ({
  db,
  interpreter,
  timeZone,
  now,
  logger,
}: ExpenseCorrectionDeps): CorrectionHandler => {
  /** Only what the principal actually wrote counts as their declaration (R-2 AC6, R-3 AC5). */
  const acceptedCorrection = async (
    text: string,
    expenseId: number,
    channelRef: string,
  ): Promise<ExpenseCorrection | 'failed' | 'budget_exhausted'> => {
    const categories = listCategories(db);
    const stored = readExpense(db, expenseId);
    const today = todayIn(timeZone, now());
    const interpretation = await interpreter({
      text,
      expense: {
        total_cents: stored.total_cents,
        merchant: stored.merchant,
        category: stored.category,
        occurred_on: stored.occurred_on,
      },
      categories,
      today,
    });
    if (interpretation.kind === 'failed' || interpretation.kind === 'budget_exhausted') {
      return interpretation.kind;
    }
    if (interpretation.kind === 'invalid') return {};
    const inferenceFor = (predicate: string) =>
      interpretation.inferences.find((inference) => inference.predicate === predicate);
    const value = (predicate: string) => inferenceFor(predicate)?.value_json ?? null;

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
      // R-18 AC3 covers an expense registered at once (a text): a correction answers a pending
      // decision, so a category that does not exist is ignored and S-15 is not asked.
      logger.info('corrected category not written or not existing; ignored', {
        channelRef,
        category,
      });
    }
    // A date is resolved by the processor ("el 28"), so the words it rests on must be written,
    // and it may not be after today (R-2 AC7).
    const date = value('occurred_on');
    const quote = textValue(
      (inferenceFor('occurred_on')?.basis_json as { quote?: unknown } | null)?.quote,
    );
    if (
      typeof date === 'string' &&
      isCalendarDate(date) &&
      date <= today &&
      quote !== null &&
      quotedFrom(quote, text)
    ) {
      correction.occurred_on = date;
    } else if (date !== null) {
      logger.info('corrected date not written, not a date or after today; ignored', {
        channelRef,
        occurred_on: date,
      });
    }
    return correction;
  };

  return async ({ decision, message }) => {
    const expenseId = pendingExpenseOf(db, decision);
    const correction = await acceptedCorrection(message.text, expenseId, message.channelRef);
    const at = now().toISOString();

    if (correction === 'budget_exhausted') {
      // R-12 AC4: nothing was stored; the decision keeps waiting for the text.
      awaitText(db, decision.id, at);
      return { text: strings.textLimitReached() };
    }
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
