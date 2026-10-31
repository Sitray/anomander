import { buttons, strings } from '@anomander/protocol';
import { z } from 'zod';
import { answerDecision, settleProposal } from '../store/decisions.ts';
import { insertAction } from '../store/expenses.ts';
import { declarePolicy } from '../store/policies.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-13 AC1, AC2: the answer to S-11 or S-12. "Sí" stores the policy (an action authorized by the
// principal), declared from the principal's message for S-11 or from the pressed button for S-12;
// "No" stores nothing and replies S-35.

const createPolicyPayload = z.object({
  merchant: z.string().min(1),
  category: z.string().min(1),
  source: z.string().min(1).nullable(),
});

export const createCreatePolicyAnswerHandler =
  (): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    if (option !== buttons.yes && option !== buttons.no) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }
    const { merchant, category, source } = createPolicyPayload.parse(decision.payload);
    const at = now().toISOString();

    db.transaction(() => {
      if (option === buttons.no) {
        answerDecision(db, decision.id, null);
        settleProposal(db, decision.proposal_id, 'rejected');
        return;
      }
      const declared = declarePolicy(db, {
        merchant,
        category,
        source: source ?? `decision:${decision.id}:${decision.options.indexOf(option)}`,
        now: at,
      });
      answerDecision(db, decision.id, declared);
      settleProposal(db, decision.proposal_id, 'executed');
      insertAction(db, decision.proposal_id, 'principal', at);
    })();
    return {
      text:
        option === buttons.no ? strings.policyNotSaved() : strings.policySaved(merchant, category),
    };
  };
