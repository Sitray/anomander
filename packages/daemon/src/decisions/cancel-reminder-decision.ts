import { buttons, strings } from '@anomander/protocol';
import { z } from 'zod';
import { answerDecision, settleProposal } from '../store/decisions.ts';
import { insertAction } from '../store/expenses.ts';
import { cancelReminders } from '../store/reminders.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-25 AC9: the answer to S-46. "Sí" cancels the reminders and tasks it named that are still
// pending, expires their `reminder` assertions and replies S-47; "No" changes nothing and replies
// S-48. One done, sent or cancelled since it was asked is left as it is.

const cancelReminderPayload = z.object({ reminder_ids: z.array(z.int().positive()) });

export const createCancelReminderAnswerHandler =
  (): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    if (option !== buttons.yes && option !== buttons.no) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }
    const { reminder_ids: reminderIds } = cancelReminderPayload.parse(decision.payload);
    const at = now().toISOString();

    db.transaction(() => {
      answerDecision(db, decision.id, null);
      settleProposal(db, decision.proposal_id, option === buttons.yes ? 'executed' : 'rejected');
      if (option === buttons.yes) {
        insertAction(db, decision.proposal_id, 'principal', at);
        cancelReminders(db, reminderIds, at);
      }
    })();
    return { text: option === buttons.yes ? strings.cancelled() : strings.notCancelled() };
  };
