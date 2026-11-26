import { buttons, strings } from '@anomander/protocol';
import { z } from 'zod';
import {
  answerCompleted,
  answerDecision,
  answerFailed,
  answerStarted,
  settleProposal,
} from '../store/decisions.ts';
import { forgetHistory, hasAction } from '../store/history.ts';
import type { DecisionAnswerHandler } from './types.ts';

// DK-14 AC4: the answer to the question that asks before erasing the history of what ANOMANDER
// did. "Sí" erases every action up to the latest one when it was asked; "No" erases nothing.
// B55: a "No" after a "Sí" that failed once the actions were erased cannot bring them back, so it
// replies S-201 instead of saying nothing was erased. B81: only then: an action erased in
// "Memoria" between the question and "No" gets "Vale, no borro nada.".

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
    // B81: the "Sí" is recorded first, so a "No" after it failed knows it ran.
    const started =
      option === buttons.yes ? answerStarted(db, decision.proposal_id, 'principal', at) : null;
    if (option === buttons.yes) {
      forgetHistory(db, upToId);
      clearRecentTurns();
    }
    db.transaction(() => {
      answerDecision(db, decision.id, null);
      settleProposal(db, decision.proposal_id, option === buttons.yes ? 'executed' : 'rejected');
      if (started !== null) answerCompleted(db, started, at);
    })();
    if (option === buttons.yes) return { text: strings.historyForgotten() };
    // B81: only a "Sí" to this question that ran erased part of it; an action erased in "Memoria"
    // meanwhile was not, so "Vale, no borro nada." stays true.
    const partErased = answerFailed(db, decision.proposal_id) && !hasAction(db, upToId);
    return {
      text: partErased ? strings.historyNotForgottenAfterPart() : strings.historyNotForgotten(),
    };
  };
