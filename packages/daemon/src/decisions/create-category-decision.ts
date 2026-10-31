import { buttons, strings } from '@anomander/protocol';
import { z } from 'zod';
import type { Logger } from '../processor/text-interpreter.ts';
import { assignDeclaredCategory, createCategory } from '../store/categories.ts';
import { answerDecision, settleProposal } from '../store/decisions.ts';
import { insertAction } from '../store/expenses.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-18 AC1, AC3: the answer to S-15. "Sí" creates the category (an action authorized by the
// principal) and, when it was declared for an expense, assigns it with `category_basis =
// 'declared'`; the reply is S-36. "No" creates nothing and replies S-34.

export interface CreateCategoryDecisionDeps {
  logger: Logger;
}

const createCategoryPayload = z.object({
  name: z.string().min(1),
  expense_id: z.int().positive().nullable(),
});

export const createCreateCategoryAnswerHandler =
  ({ logger }: CreateCategoryDecisionDeps): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    if (option !== buttons.yes && option !== buttons.no) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }
    const { name, expense_id: expenseId } = createCategoryPayload.parse(decision.payload);
    const at = now().toISOString();

    const assigned = db.transaction(() => {
      answerDecision(db, decision.id, null);
      settleProposal(db, decision.proposal_id, option === buttons.yes ? 'executed' : 'rejected');
      if (option === buttons.no) return false;
      insertAction(db, decision.proposal_id, 'principal', at);
      const categoryId = createCategory(db, name, at);
      return expenseId !== null && assignDeclaredCategory(db, expenseId, categoryId);
    })();
    if (option === buttons.no) return { text: strings.categoryNotCreated() };
    if (expenseId !== null && !assigned) {
      logger.info('expense already has a category; the new one is not assigned', {
        decisionId: decision.id,
        expenseId,
      });
    }
    return { text: strings.categoryCreated(name.toLowerCase()) };
  };
