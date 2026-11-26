import { buttons, strings } from '@anomander/protocol';
import { z } from 'zod';
import {
  answerCompleted,
  answerDecision,
  answerFailed,
  answerStarted,
  settleProposal,
} from '../store/decisions.ts';
import { forgetMemories, isForgottenMemory } from '../store/memory.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-23 AC6: the answer to S-29. "Sí" erases the memories it named and replies S-30; "No" erases
// nothing and replies S-31. A memory forgotten or replaced since it was asked has no text left
// to erase: a replacement erases the old text (R-23 AC3), so S-30 is always true. B55: a "Sí"
// that failed once its memories were forgotten leaves the question open; a "No" after it cannot
// bring them back, so it replies S-200 instead of saying nothing was forgotten. B81: only then: a
// memory forgotten in "Memoria" between the question and "No" gets S-31.

export interface ForgetMemoryDecisionDeps {
  /**
   * Erases the stored conversation and so the recent turns, so the forgotten text leaves the
   * conversation and the database (R-16 AC3, DK-16).
   */
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

    // Erased before the answer is recorded, each in a transaction of its own (the WAL checkpoint
    // cannot run inside one): when an erase fails the question stays open, so "Sí" can be
    // pressed again; erasing twice changes nothing.
    // B81: the "Sí" is recorded first, so a "No" after it failed knows it ran.
    const started =
      option === buttons.yes ? answerStarted(db, decision.proposal_id, 'principal', at) : null;
    if (option === buttons.yes) {
      forgetMemories(db, memoryIds);
      clearRecentTurns();
    }
    db.transaction(() => {
      answerDecision(db, decision.id, null);
      settleProposal(db, decision.proposal_id, option === buttons.yes ? 'executed' : 'rejected');
      if (started !== null) answerCompleted(db, started, at);
    })();
    if (option === buttons.yes) return { text: strings.forgotten() };
    // B81: only a "Sí" to this question that ran forgot part of it; one forgotten in "Memoria"
    // meanwhile was not, so S-31 stays true.
    const partForgotten =
      answerFailed(db, decision.proposal_id) && memoryIds.some((id) => isForgottenMemory(db, id));
    return { text: partForgotten ? strings.notForgottenAfterPart() : strings.notForgotten() };
  };
