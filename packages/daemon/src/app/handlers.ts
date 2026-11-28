import type { Notify } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { budgeted, createAiBudget } from '../budget/ai-budget.ts';
import type { Config, ModelId } from '../config.ts';
import { createRecentTurns } from '../conversation/recent-turns.ts';
import { createButtonHandler, createDecisionAnswers } from '../decisions/answer.ts';
import { createCancelReminderAnswerHandler } from '../decisions/cancel-reminder-decision.ts';
import { createAmendExpenseCorrection, createExpenseCorrection } from '../decisions/correction.ts';
import { createCreateCategoryAnswerHandler } from '../decisions/create-category-decision.ts';
import { createCreatePolicyAnswerHandler } from '../decisions/create-policy-decision.ts';
import { createForgetHistoryAnswerHandler } from '../decisions/forget-history-decision.ts';
import { createForgetMemoryAnswerHandler } from '../decisions/forget-memory-decision.ts';
import { createGrantDigestAnswerHandler } from '../decisions/grant-digest-decision.ts';
import { createGrantWeeklySummaryAnswerHandler } from '../decisions/grant-weekly-summary-decision.ts';
import { createTextRouter } from '../decisions/router.ts';
import { createReceiptExpenseCycle } from '../expenses/receipt-expense.ts';
import { createTextExpenseHandler, type TextExpenseDeps } from '../expenses/text-expense.ts';
import { createPatternOffers } from '../patterns/pattern-offers.ts';
import { turnAborted, withCancel } from '../processor/cancel.ts';
import { createPiAiCorrectionInterpreter } from '../processor/correction-interpreter.ts';
import type { Logger } from '../processor/ports.ts';
import { createPiAiReceiptReader } from '../processor/receipt-reader.ts';
import { createPiAiReplyPhraser } from '../processor/reply-phraser.ts';
import { withRetry } from '../processor/retry.ts';
import { createPiAiTextInterpreter } from '../processor/text-interpreter.ts';
import { withTimeout } from '../processor/timeout.ts';
import { createKeepReceiptAnswerHandler } from '../retention/keep-receipt-decision.ts';
import { createModelProbe } from '../setup/model-probe.ts';
import type { SetupGap } from '../setup/setup-guide.ts';
import { doorOf, routesOf } from './commands.ts';
import type { AnomanderDeps } from './types.ts';

export interface HandlersDeps<M> {
  config: Config;
  db: Database.Database;
  deps: Pick<AnomanderDeps<M>, 'complete' | 'model' | 'visionModel'>;
  /** `config.model` and `config.visionModel`, both set. */
  textModel: ModelId;
  visionModel: ModelId;
  setupGaps: () => Promise<readonly SetupGap[]>;
  notify: Notify;
  connected: NonNullable<TextExpenseDeps['connected']>;
  now: () => Date;
  logger: Logger;
}

/**
 * The processor's calls, under the daily cap and their timeouts, and the handlers of a text, a
 * receipt and a button press that use them.
 */
export const createHandlers = <M>({
  config,
  db,
  deps,
  textModel,
  visionModel,
  setupGaps,
  notify,
  connected,
  now,
  logger,
}: HandlersDeps<M>) => {
  const { complete, model } = deps;
  // R-12: every processor call counts against the daily cap. A receipt reserves its reader call
  // before reading, so the reader gets the raw call (see `ReceiptExpenseDeps.budget`).
  const budget = createAiBudget({
    db,
    limit: config.dailyAiCallLimit,
    timeZone: config.timeZone,
    now,
  });
  // R-22 AC2, AC3: each attempt has its own timeout; each retry counts against the budget.
  // DK-19: a turn stopped from the app aborts its processor call, whichever wrapper made it.
  const timed = withRetry(withTimeout(withCancel(complete), config.processorTimeoutMs), {
    // DK-19: a stopped turn makes no retry, so it spends none.
    mayRetry: () => !turnAborted() && budget.tryConsume(),
    logger,
  });
  // DK-19: outside the budget too, so a call refused after a stop is never counted (R-12).
  const ai = withCancel(budgeted(timed, budget));
  // DK-23 AC4: "Probar": one call, never retried, counted against the budget. B88: it also
  // checks that the model receipts are read with (below) reads images.
  const probe = createModelProbe({
    complete,
    model,
    visionModel: deps.visionModel ?? model,
    budget,
    gaps: setupGaps,
    timeoutMs: config.processorTimeoutMs,
    logger,
  });

  const phraser = createPiAiReplyPhraser({ complete: ai, model, logger });
  // R-16 AC3, DK-16: every exchange with the principal is a recent turn, kept in the stored
  // conversation, which survives a restart; the interpreter reads only the latest ones.
  const turns = createRecentTurns({ db, now, logger });
  const patterns = createPatternOffers({ db, now, logger, notify: (message) => notify(message) });
  const correcting = {
    db,
    interpreter: createPiAiCorrectionInterpreter({ complete: ai, model, logger }),
    timeZone: config.timeZone,
    now,
    logger,
    patterns,
  };
  const onText = createTextRouter({
    db,
    corrections: {
      register_expense: createExpenseCorrection(correcting),
      // R-7 AC6: the text after "Corregir" under a typed expense's reply.
      amend_expense: createAmendExpenseCorrection(correcting),
    },
    otherwise: createTextExpenseHandler({
      db,
      interpreter: createPiAiTextInterpreter({ complete: ai, model, logger }),
      phraser,
      timeZone: config.timeZone,
      now,
      processorSource: `processor:${textModel.provider}/${textModel.id}`,
      logger,
      recent: turns.recent,
      patterns,
      routes: (message) => routesOf(doorOf(message.channelRef)),
      connected,
    }),
    now,
  });
  const vision = deps.visionModel === undefined ? textModel : visionModel;
  const receipts = createReceiptExpenseCycle({
    db,
    reader: createPiAiReceiptReader({ complete: timed, model: deps.visionModel ?? model, logger }),
    phraser,
    inboxDir: config.inboxDir,
    timeZone: config.timeZone,
    now,
    processorSource: `processor:${vision.provider}/${vision.id}`,
    logger,
    budget,
  });
  const onButton = createButtonHandler({
    db,
    answers: {
      ...createDecisionAnswers({ phraser, logger, patterns }),
      keep_receipt: createKeepReceiptAnswerHandler({ timeZone: config.timeZone }),
      // R-16 AC3, DK-16: a confirmed forget erases the stored conversation and so the turns.
      forget_memory: createForgetMemoryAnswerHandler({ clearRecentTurns: turns.clear }),
      // DK-14 AC4: "Sí" erases the history of what ANOMANDER did.
      forget_history: createForgetHistoryAnswerHandler({ clearRecentTurns: turns.clear }),
      // R-18 AC1, AC3: "Sí" to S-15 creates the category.
      create_category: createCreateCategoryAnswerHandler({ logger }),
      // R-13 AC1, AC2: "Sí" to S-11 or S-12 stores the policy.
      create_policy: createCreatePolicyAnswerHandler(),
      // R-25 AC9: "Sí" to S-46 cancels the reminders and tasks it named.
      cancel_reminder: createCancelReminderAnswerHandler(),
      // R-26 AC2: "Sí" to S-53 grants the morning digest's permission.
      grant_morning_digest: createGrantDigestAnswerHandler(),
      // R-10 AC6: "Sí" to S-74 grants the weekly summary's permission.
      grant_weekly_summary: createGrantWeeklySummaryAnswerHandler(),
    },
    now,
    logger,
  });

  return { budget, ai, probe, turns, onText, receipts, onButton };
};
