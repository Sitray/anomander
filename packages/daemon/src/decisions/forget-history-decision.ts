import { buttons, strings } from '@anomander/protocol';
import { z } from 'zod';
import { answerDecision, settleProposal } from '../store/decisions.ts';
import { insertAction } from '../store/expenses.ts';
import { forgetHistory, hasAction } from '../store/history.ts';
import type { DecisionAnswerHandler } from './types.ts';

// DK-14 AC4: the answer to the question that asks before erasing the history of what ANOMANDER
// did. "Sí" erases every action up to the latest one when it was asked; "No" erases nothing.
// B55: a "No" after a "Sí" that failed once the actions were erased cannot bring them back, so it
// replies S-201 instead of saying nothing was erased.

export interface ForgetHistoryDecisionDeps {
  /**
   * Erases the stored conversation and so the recent turns, which also carry the words of what
   * was done (R-16 AC3, DK-16).
   */
  clearRecentTurns: () => void;
}

const forgetHistoryPayload = z.object({ up_to_id: z.int().positive() });

export const createForgetHistoryAnswerHandler =
  ({ clearRecentTurns }: ForgetHistoryDecisionDeps): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    if (option !== buttons.yes && option !== buttons.no) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }
    const { up_to_id: upToId } = forgetHistoryPayload.parse(decision.payload);
    const at = now().toISOString();

    // Erased before the answer is recorded, as `forget_memory` erases: when an erase fails the
    // question stays open, so "Sí" can be pressed again; erasing twice changes nothing. The
    // actions go first, as `forget_memory` erases the memories first: a failure after them is
    // seen by a later "No", one before them erased nothing.
    if (option === buttons.yes) {
      forgetHistory(db, upToId);
      clearRecentTurns();
    }
    db.transaction(() => {
      answerDecision(db, decision.id, null);
      settleProposal(db, decision.proposal_id, option === buttons.yes ? 'executed' : 'rejected');
      if (option === buttons.yes) insertAction(db, decision.proposal_id, 'principal', at);
    })();
    if (option === buttons.yes) return { text: strings.historyForgotten() };
    return {
      text: hasAction(db, upToId)
        ? strings.historyNotForgotten()
        : strings.historyNotForgottenAfterPart(),
    };
  };
