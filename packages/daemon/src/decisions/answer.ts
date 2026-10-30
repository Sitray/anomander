import { type ButtonHandler, strings } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { Logger } from '../processor/text-interpreter.ts';
import { asOpenDecision, loadDecision, reopenStaleAwaiting } from '../store/decisions.ts';
import {
  createRegisterExpenseDecision,
  type RegisterExpenseDecisionDeps,
} from './register-expense-decision.ts';
import type { DecisionAnswerHandler } from './types.ts';

// R-17 AC1: a button press goes to the decision named in its data, and the answer is dispatched
// by the operation of the decision's proposal.

/** The dispatch table: one handler per proposal `operation`. */
export type DecisionAnswers = Record<string, DecisionAnswerHandler>;

/**
 * The answers this package knows. Add another operation by spreading this record, e.g.
 * `{ ...createDecisionAnswers(deps), keep_receipt: answerKeepReceipt }`.
 */
export const createDecisionAnswers = (deps: RegisterExpenseDecisionDeps): DecisionAnswers => ({
  register_expense: createRegisterExpenseDecision(deps),
});

export interface ButtonHandlerDeps {
  db: Database.Database;
  answers: DecisionAnswers;
  now: () => Date;
  logger: Logger;
}

const BUTTON_DATA = /^decision:(\d+):(\d+)$/;

export const createButtonHandler =
  ({ db, answers, now, logger }: ButtonHandlerDeps): ButtonHandler =>
  async (press) => {
    // R-17 AC6: a decision left awaiting text for 15 minutes is `open` again.
    reopenStaleAwaiting(db, now());
    const match = BUTTON_DATA.exec(press.data);
    const stored = match === null ? null : loadDecision(db, Number(match[1]));
    const decision = asOpenDecision(stored);
    const option = decision?.options[Number(match?.[2])];
    const answer = decision === null ? undefined : answers[decision.operation];
    // R-17 AC1: a decision that is not open, or data that names none, gets S-19 and changes nothing.
    if (decision === null || option === undefined || answer === undefined) {
      logger.info('button press for no open decision', {
        data: press.data,
        status: stored?.status ?? null,
        operation: stored?.operation ?? null,
      });
      return { text: strings.decisionClosed() };
    }
    return answer({ db, decision, option, now });
  };
