import { buttons, strings } from '@anomander/protocol';
import { z } from 'zod';
import { answerDecision, settleProposal } from '../store/decisions.ts';
import { grantDigestPermission } from '../store/digest.ts';
import { insertAction } from '../store/expenses.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-26 AC2: the answer to S-53. "Sí" grants the `send_morning_digest` permission at the asked
// time, revoking any earlier one (an action authorized by the principal, §8.1), and replies S-54;
// "No" grants nothing and replies S-55.

const grantDigestPayload = z.object({ time: z.string().regex(/^\d{2}:\d{2}$/) });

export const createGrantDigestAnswerHandler =
  (): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    if (option !== buttons.yes && option !== buttons.no) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }
    const { time } = grantDigestPayload.parse(decision.payload);
    const at = now().toISOString();

    db.transaction(() => {
      answerDecision(db, decision.id, null);
      settleProposal(db, decision.proposal_id, option === buttons.yes ? 'executed' : 'rejected');
      if (option === buttons.yes) {
        insertAction(db, decision.proposal_id, 'principal', at);
        grantDigestPermission(db, time, at);
      }
    })();
    return { text: option === buttons.yes ? strings.digestOn(time) : strings.digestNotOn() };
  };
