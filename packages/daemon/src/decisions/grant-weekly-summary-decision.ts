import { buttons, strings } from '@anomander/protocol';
import { answerDecision, settleProposal } from '../store/decisions.ts';
import { insertAction } from '../store/expenses.ts';
import { grantPermission } from '../store/permissions.ts';
import { WEEKLY_SUMMARY_OPERATION } from '../summary/weekly-summary.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-10 AC6: the answer to S-74. "Sí" grants the `send_weekly_summary` permission (an action
// authorized by the principal, §8.1) and replies S-75; "No" grants nothing and replies S-55.

export const createGrantWeeklySummaryAnswerHandler =
  (): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    if (option !== buttons.yes && option !== buttons.no) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }
    const at = now().toISOString();

    db.transaction(() => {
      answerDecision(db, decision.id, null);
      settleProposal(db, decision.proposal_id, option === buttons.yes ? 'executed' : 'rejected');
      if (option === buttons.yes) {
        insertAction(db, decision.proposal_id, 'principal', at);
        grantPermission(db, WEEKLY_SUMMARY_OPERATION, {}, at);
      }
    })();
    return { text: option === buttons.yes ? strings.weeklySummaryOn() : strings.digestNotOn() };
  };
