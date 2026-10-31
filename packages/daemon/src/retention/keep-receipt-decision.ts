import { todayIn } from '@anomander/core';
import { buttons, strings } from '@anomander/protocol';
import { z } from 'zod';
import type { DecisionAnswerHandler } from '../decisions/types.ts';
import { answerDecision } from '../store/decisions.ts';
import { insertAction, insertAssertion } from '../store/expenses.ts';
import { keepReceiptLonger } from './queued-receipts.ts';

// R-8 AC4: the answer to S-13. "Sí" keeps the unread receipt until it is read, at most 7 days
// after `received_at`, and replies S-24; "No" leaves `keep_until` as it is and replies S-25.

export interface KeepReceiptDecisionDeps {
  timeZone: string;
}

const keepReceiptPayload = z.object({ document_id: z.int().positive() });

export const createKeepReceiptAnswerHandler =
  ({ timeZone }: KeepReceiptDecisionDeps): DecisionAnswerHandler =>
  async ({ db, decision, option, now }) => {
    if (option !== buttons.yes && option !== buttons.no) {
      throw new Error(`unknown option ${JSON.stringify(option)} for decision ${decision.id}`);
    }
    const { document_id: documentId } = keepReceiptPayload.parse(decision.payload);
    const at = now().toISOString();
    const settle = db.prepare('UPDATE proposals SET status = ? WHERE id = ? AND status = ?');

    const keptUntil = db.transaction((): string | null | 'closed' => {
      if (option === buttons.no) {
        answerDecision(db, decision.id, null);
        settle.run('rejected', decision.proposal_id, 'asked');
        return null;
      }
      const keepUntil = keepReceiptLonger(db, documentId);
      // Read or discarded since it was asked: there is nothing left to keep.
      if (keepUntil === null) return 'closed';
      const answerId = insertAssertion(
        db,
        {
          subject_type: 'document',
          subject_id: documentId,
          predicate: 'keep_until',
          value_json: keepUntil,
          mode: 'declared',
          actor: 'principal',
          source: `decision:${decision.id}:${decision.options.indexOf(option)}`,
          basis_json: null,
          confidence: null,
          valid_at: at,
          expires_at: null,
          status: 'current',
          supersedes_id: null,
          confirms_id: null,
        },
        at,
      );
      answerDecision(db, decision.id, answerId);
      settle.run('executed', decision.proposal_id, 'asked');
      insertAction(db, decision.proposal_id, 'principal', at);
      return keepUntil;
    })();

    if (keptUntil === 'closed') return { text: strings.decisionClosed() };
    if (keptUntil === null) return { text: strings.receiptNotKept() };
    // S-24 names the last day it is kept, in `TZ`.
    return { text: strings.receiptKept(todayIn(timeZone, new Date(keptUntil))) };
  };
