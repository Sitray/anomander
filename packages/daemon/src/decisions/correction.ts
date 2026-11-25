import { isCalendarDate, isLiteralAmount, type ProcessorInference, todayIn } from '@anomander/core';
import {
  buttons,
  decisionButtons,
  type PrincipalText,
  type Reply,
  strings,
} from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { textValue, writtenIn } from '../expenses/declarations.ts';
import { type PatternOffers, thenOfferPattern } from '../patterns/pattern-offers.ts';
import type { CorrectionInterpreter } from '../processor/correction-interpreter.ts';
import type { Logger } from '../processor/ports.ts';
import {
  amendExpense,
  amendedExpenseOf,
  type CorrectionRestore,
  closeAmendDecisions,
  currentExpenseOf,
  openCorrectionUndoDecision,
  restoreOf,
} from '../store/amend-expense.ts';
import {
  answerDecision,
  awaitText,
  correctExpense,
  type ExpenseCorrection,
  pendingExpenseOf,
  registerByPrincipal,
} from '../store/decisions.ts';
import { listCategories, readExpense, type StoredExpense } from '../store/expenses.ts';
import { quotedFrom } from '../store/memory.ts';
import { recordDecisionMessage } from '../store/receipts.ts';
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
  /** Offers S-12 after a correction completes a pattern (R-13 AC2); none when absent. */
  patterns?: PatternOffers;
}

export interface CorrectionValues {
  /** The principal's correction text. */
  text: string;
  /** The processor's inferences about it: `total`, `merchant`, `category`, `occurred_on`. */
  inferences: readonly ProcessorInference[];
  categories: readonly string[];
  /** Today in `TZ`. */
  today: string;
  channelRef: string;
  logger: Logger;
}

/**
 * R-7 AC2: only what the principal actually wrote counts as their declaration (R-2 AC6, R-3 AC5):
 * an amount written literally, a merchant and an existing category written in the text, and a
 * date resting on written words and not after today. Everything else is ignored and logged
 * without the text.
 */
export const acceptCorrection = ({
  text,
  inferences,
  categories,
  today,
  channelRef,
  logger,
}: CorrectionValues): ExpenseCorrection => {
  const inferenceFor = (predicate: string) =>
    inferences.find((inference) => inference.predicate === predicate);
  const value = (predicate: string) => inferenceFor(predicate)?.value_json ?? null;

  const correction: ExpenseCorrection = {};
  const total = value('total');
  if (typeof total === 'number' && total > 0 && isLiteralAmount(text, total)) {
    correction.total_cents = total;
  } else if (total !== null) {
    // §16: the proposed amount is the principal's data; only the reason is logged.
    logger.warn('corrected amount is not written in the message; ignored', { channelRef });
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
    logger.info('corrected category not written or not existing; ignored', { channelRef });
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
    });
  }
  return correction;
};

/** S-8 from the stored row, verbatim (R-21 AC3); S-102 when it has no merchant. */
export const correctedReply = (stored: StoredExpense): string =>
  stored.merchant === null
    ? strings.correctedNoMerchant(stored.total, stored.category)
    : strings.corrected(stored.total, stored.merchant, stored.category);

export interface CorrectionUndoAsk {
  expenseId: number;
  restore: CorrectionRestore;
  /** The principal's correction message. */
  source: string;
  now: string;
}

/**
 * R-7 AC9: S-8 or S-102 for a corrected registered expense, and the question its "Deshacer"
 * answers. Called in the correction's transaction, after its other questions were closed (AC8).
 */
export const askUndoCorrection = (
  db: Database.Database,
  { expenseId, restore, source, now }: CorrectionUndoAsk,
): { text: string; decisionId: number } => {
  const text = correctedReply(readExpense(db, expenseId));
  const decisionId = openCorrectionUndoDecision(db, {
    expenseId,
    restore,
    source,
    question: text,
    options: [buttons.undo],
    now,
  });
  return { text, decisionId };
};

/**
 * R-7 AC9: the reply carries its question's "Deshacer", in Telegram and in the app, and its
 * delivery records the message that shows it (R-17 AC2).
 */
export const withUndoButton = (
  db: Database.Database,
  reply: Reply,
  decisionId: number,
  logger: Logger,
): Reply => ({
  ...reply,
  buttons: decisionButtons(decisionId, [buttons.undo]),
  onDelivered: (delivery) => {
    reply.onDelivered?.(delivery);
    if (!recordDecisionMessage(db, decisionId, delivery.channelRef)) {
      logger.warn('decision message already recorded', { decisionId });
    }
  },
});

/** What a decision's correction is applied to, and how. */
interface CorrectionTarget {
  /**
   * The expense the decision is about; `null` when it can no longer be corrected, and the
   * question was closed (S-19).
   */
  expenseOf: (decision: OpenDecision) => number | null;
  /**
   * Writes the accepted correction and answers the decision, in one transaction. Returns the
   * action and, for a registered expense, what "Deshacer" under the reply puts back (R-7 AC9).
   */
  apply: (
    decision: OpenDecision,
    expenseId: number,
    correction: ExpenseCorrection,
    message: PrincipalText,
    at: string,
  ) => { actionId: number; restore?: CorrectionRestore };
}

const createCorrection = (
  { db, interpreter, timeZone, now, logger, patterns }: ExpenseCorrectionDeps,
  { expenseOf, apply }: CorrectionTarget,
): CorrectionHandler => {
  const acceptedCorrection = async (
    text: string,
    expenseId: number,
    channelRef: string,
  ): Promise<ExpenseCorrection | 'failed' | 'budget_exhausted' | 'invalid'> => {
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
    if (interpretation.kind === 'invalid') {
      logger.warn('correction not interpreted', { channelRef, reason: interpretation.reason });
      return 'invalid';
    }
    return acceptCorrection({
      text,
      inferences: interpretation.inferences,
      categories,
      today,
      channelRef,
      logger,
    });
  };

  return async ({ decision, message }) => {
    const expenseId = expenseOf(decision);
    // R-7 AC8: the expense was undone or corrected meanwhile; its question is closed.
    if (expenseId === null) return { text: strings.decisionClosed() };
    const correction = await acceptedCorrection(message.text, expenseId, message.channelRef);
    const at = now().toISOString();
    // Only "Corregir" makes a decision wait for text (R-7 AC1). A decision already waiting keeps
    // waiting (R-17 AC3); one answered by a Telegram reply stays `open` (AC2), so the principal's
    // next unrelated text is not taken as a correction.
    const keepWaiting = () => {
      if (decision.status === 'awaiting_text') awaitText(db, decision.id, at);
    };

    if (correction === 'budget_exhausted') {
      // R-12 AC4: nothing was stored; the decision is left as it was.
      keepWaiting();
      return { text: strings.textLimitReached() };
    }
    if (correction === 'failed' || correction === 'invalid') {
      // R-22 AC1: nothing was stored, whether the processor failed or gave an answer code cannot
      // use; the decision is left as it was, for the text to come again.
      if (correction === 'failed') {
        logger.error('correction not handled: the processor failed', {
          channelRef: message.channelRef,
        });
      }
      keepWaiting();
      return { text: strings.processingFailed() };
    }
    if (Object.keys(correction).length === 0) {
      // Nothing usable: S-7 again, and the decision is left as it was.
      keepWaiting();
      return { text: strings.askCorrection() };
    }

    const { actionId, text, undoId } = db.transaction(() => {
      const applied = apply(decision, expenseId, correction, message, at);
      if (applied.restore === undefined) {
        // R-9 AC1: S-8 from the stored row, verbatim (R-21 AC3: only S-1, S-2, S-16, S-21 are
        // phrased).
        return { ...applied, text: correctedReply(readExpense(db, expenseId)), undoId: null };
      }
      const asked = askUndoCorrection(db, {
        expenseId,
        restore: applied.restore,
        source: message.channelRef,
        now: at,
      });
      return { actionId: applied.actionId, text: asked.text, undoId: asked.decisionId };
    })();

    const reply = verifiedReply(db, actionId, text, now, logger);
    return thenOfferPattern(
      undoId === null ? reply : withUndoButton(db, reply, undoId, logger),
      expenseId,
      patterns,
    );
  };
};

/** The correction of a pending `register_expense` decision: the expense is corrected and registered. */
export const createExpenseCorrection = (deps: ExpenseCorrectionDeps): CorrectionHandler =>
  createCorrection(deps, {
    expenseOf: (decision) => pendingExpenseOf(deps.db, decision),
    // R-7 AC2: declare, supersede and refute, update the expense, and register it.
    apply: (decision, expenseId, correction, message, at) => {
      const { db } = deps;
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
      return { actionId: registered.actionId };
    },
  });

/**
 * R-7 AC6: the correction of a typed expense after "Corregir" (an `amend_expense` decision): the
 * current expense is corrected as R-7 AC2 writes it, and its other questions are closed (AC8).
 */
export const createAmendExpenseCorrection = (deps: ExpenseCorrectionDeps): CorrectionHandler =>
  createCorrection(deps, {
    expenseOf: (decision) => {
      const expenseId = currentExpenseOf(deps.db, decision);
      if (expenseId === null) closeAmendDecisions(deps.db, amendedExpenseOf(decision));
      return expenseId;
    },
    apply: (decision, expenseId, correction, message, at) => {
      const { db } = deps;
      // R-17 AC2: a Telegram reply to a correction's reply (R-7 AC9) corrects the expense again, as
      // a typed correction does (AC7): its "Deshacer" is not what the new correction executes, so
      // it is closed with the expense's other questions (AC8).
      const undoQuestion = restoreOf(decision) !== null;
      const { actionId, declarations, restore } = amendExpense(db, {
        expenseId,
        proposalId: undoQuestion ? null : decision.proposal_id,
        correction,
        source: message.channelRef,
        receivedAt: message.receivedAt,
        now: at,
      });
      if (!undoQuestion) answerDecision(db, decision.id, declarations[0] ?? null);
      closeAmendDecisions(db, expenseId);
      return { actionId, restore };
    },
  });
