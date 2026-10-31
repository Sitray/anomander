import { buttons, strings } from '@anomander/protocol';
import { z } from 'zod';
import { answerDecision, settleProposal } from '../store/decisions.ts';
import { insertAction } from '../store/expenses.ts';
import { forgetMemories } from '../store/memory.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-23 AC6: the answer to S-29. "Sí" erases the memories it named and replies S-30; "No" erases
// nothing and replies S-31. A memory forgotten or replaced since it was asked has no text left
// to erase: a replacement erases the old text (R-23 AC3), so S-30 is always true.

export interface ForgetMemoryDecisionDeps {
  /** Empties the recent turns, so the forgotten text leaves the conversation (R-16 AC3). */
  clearRecentTurns: () => void;
}

const forgetMemoryPayload = z.object({ memory_ids: z.array(z.int().positive()) });

export const createForgetMemoryAnswerHandler =
  ({ clearRecentTurns }: ForgetMemoryDecisionDeps): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    if (option !== buttons.yes && option !== buttons.no) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }
    const { memory_ids: memoryIds } = forgetMemoryPayload.parse(decision.payload);
    const at = now().toISOString();

    db.transaction(() => {
      answerDecision(db, decision.id, null);
      settleProposal(db, decision.proposal_id, option === buttons.yes ? 'executed' : 'rejected');
      if (option === buttons.yes) insertAction(db, decision.proposal_id, 'principal', at);
    })();
    if (option === buttons.no) return { text: strings.notForgotten() };

    // Erased after the answer is recorded: the WAL checkpoint cannot run inside a transaction.
    forgetMemories(db, memoryIds);
    clearRecentTurns();
    return { text: strings.forgotten() };
  };
