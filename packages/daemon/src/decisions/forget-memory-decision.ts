import { buttons, strings } from '@anomander/protocol';
import { z } from 'zod';
import { answerDecision, settleProposal } from '../store/decisions.ts';
import { insertAction } from '../store/expenses.ts';
import { forgetMemories } from '../store/memory.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-23 AC6: the answer to S-29. "Sí" erases the memories it named and replies S-30; "No" erases
// nothing and replies S-31. A memory forgotten or replaced since it was asked has no text left
// to erase: a replacement erases the old text (R-23 AC3), so S-30 is always true. The turns of
// the stored conversation that hold the text or quote go with it, S-29 and the message that asked
// among them (`forgetMemories`); the rest of the conversation stays.

/** It needs nothing more: `forgetMemories` erases the turns too. Kept for `src/index.ts`. */
export type ForgetMemoryDecisionDeps = Record<string, never>;

const forgetMemoryPayload = z.object({ memory_ids: z.array(z.int().positive()) });

export const createForgetMemoryAnswerHandler =
  (): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    if (option !== buttons.yes && option !== buttons.no) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }
    const { memory_ids: memoryIds } = forgetMemoryPayload.parse(decision.payload);
    const at = now().toISOString();

    // Erased before the answer is recorded, in a transaction of its own (the WAL checkpoint
    // cannot run inside one): when the erase fails the question stays open, so "Sí" can be
    // pressed again; erasing twice changes nothing.
    if (option === buttons.yes) forgetMemories(db, memoryIds);
    db.transaction(() => {
      answerDecision(db, decision.id, null);
      settleProposal(db, decision.proposal_id, option === buttons.yes ? 'executed' : 'rejected');
      if (option === buttons.yes) insertAction(db, decision.proposal_id, 'principal', at);
    })();
    return { text: option === buttons.yes ? strings.forgotten() : strings.notForgotten() };
  };
