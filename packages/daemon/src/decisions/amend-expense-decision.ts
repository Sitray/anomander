import { buttons, strings } from '@anomander/protocol';
import type { Logger } from '../processor/ports.ts';
import {
  amendedExpenseOf,
  closeAmendDecisions,
  correctionStands,
  currentExpenseOf,
  restoreOf,
  undoCorrection,
  undoExpense,
} from '../store/amend-expense.ts';
import { answerDecision, awaitText } from '../store/decisions.ts';
import { readExpense } from '../store/expenses.ts';
import { verifiedReply } from './register-expense-decision.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-7 AC4 to AC6, AC8: the answers to the "Deshacer" and "Corregir" under a typed expense's reply
// (an `amend_expense` decision), and R-7 AC9: the "Deshacer" under a correction's reply. The
// correction text itself goes to `createAmendExpenseCorrection`.

export interface AmendExpenseDecisionDeps {
  logger: Logger;
}

export const createAmendExpenseDecision =
  ({ logger }: AmendExpenseDecisionDeps): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    const at = now().toISOString();
    const expenseId = currentExpenseOf(db, decision);
    if (expenseId === null) {
      // R-7 AC8: the expense was undone or corrected meanwhile; its question is closed (S-19).
      closeAmendDecisions(db, amendedExpenseOf(decision));
      logger.info('amend question for an expense no longer current', { decisionId: decision.id });
      return { text: strings.decisionClosed() };
    }

    if (option === buttons.correct) {
      // R-7 AC6 as AC1: S-7, verbatim, and the decision waits for the principal's text.
      awaitText(db, decision.id, at);
      return { text: strings.askCorrection() };
    }
    if (option !== buttons.undo) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }

    const restore = restoreOf(decision);
    if (restore !== null) {
      // R-7 AC9: a correction no longer standing was overtaken; its question is closed (S-19).
      if (!correctionStands(db, restore)) {
        closeAmendDecisions(db, expenseId);
        logger.info('undo of a correction that no longer stands', { decisionId: decision.id });
        return { text: strings.decisionClosed() };
      }
      // The expense goes back to its values right before the correction and stays recorded;
      // S-105 or S-106 from the stored row, verbatim.
      const actionId = db.transaction(() => {
        const undone = undoCorrection(db, {
          expenseId,
          proposalId: decision.proposal_id,
          restore,
          now: at,
        });
        answerDecision(db, decision.id, null);
        closeAmendDecisions(db, expenseId);
        return undone;
      })();
      const stored = readExpense(db, expenseId);
      const text =
        stored.merchant === null
          ? strings.restoredNoMerchant(stored.total, stored.category)
          : strings.restored(stored.total, stored.merchant, stored.category);
      return verifiedReply(db, actionId, text, now, logger);
    }

    // R-7 AC5: the expense leaves the ledger as a discarded one does; S-100 or S-101, verbatim.
    const actionId = db.transaction(() => {
      const undone = undoExpense(db, { expenseId, proposalId: decision.proposal_id, now: at });
      answerDecision(db, decision.id, null);
      closeAmendDecisions(db, expenseId);
      return undone;
    })();
    const stored = readExpense(db, expenseId);
    const text =
      stored.merchant === null
        ? strings.undoneNoMerchant(stored.total)
        : strings.undone(stored.total, stored.merchant);
    return verifiedReply(db, actionId, text, now, logger);
  };
