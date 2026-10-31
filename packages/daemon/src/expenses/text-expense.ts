import {
  categorize,
  checkAuthority,
  isCalendarDate,
  isLiteralAmount,
  type ProcessorInference,
  todayIn,
} from '@anomander/core';
import {
  formatAmount,
  formatDate,
  strings,
  type TextHandler,
  UNCATEGORIZED,
} from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { ReplyPhraser } from '../processor/reply-phraser.ts';
import type { Logger, TextInterpreter } from '../processor/text-interpreter.ts';
import {
  listActivePolicies,
  listCategories,
  readExpense,
  recordReplyDelivery,
  registerTextExpense,
} from '../store/expenses.ts';
import { textValue, writtenIn } from './declarations.ts';

// PRD §10 for a text such as "23 € cena": interpret (processor), check the amount against the
// literal message (R-2 AC6), categorize (R-5), check authority (R-2 AC2), act, verify (R-9).
// Replies are worded by the phraser around facts read from the database (R-21).

export interface TextExpenseDeps {
  db: Database.Database;
  interpreter: TextInterpreter;
  /** `TZ`: today is computed there (R-2 AC7). */
  timeZone: string;
  now: () => Date;
  /** The assertion source of processor inferences, e.g. `processor:openai/gpt-4o-mini`. */
  processorSource: string;
  /** Words S-1, S-2, S-16 and S-21 (R-21). */
  phraser: ReplyPhraser;
  logger: Logger;
}

const inferenceOf = (inferences: readonly ProcessorInference[], predicate: string) =>
  inferences.find((inference) => inference.predicate === predicate);

const inferredValue = (inferences: readonly ProcessorInference[], predicate: string): unknown =>
  inferenceOf(inferences, predicate)?.value_json ?? null;

export const createTextExpenseHandler = (deps: TextExpenseDeps): TextHandler => {
  const { db, interpreter, timeZone, now, processorSource, phraser, logger } = deps;

  return async (message) => {
    const phrase = (reference: string, facts: string[]) =>
      phraser({ reference, facts, message: message.text });
    const unclearAmount = async () => ({ text: await phrase(strings.unclearAmount(), []) });

    const today = todayIn(timeZone, now());
    const categories = listCategories(db);
    const interpretation = await interpreter({ text: message.text, today, categories });

    // R-16: open conversation gets its reply and nothing is persisted.
    if (interpretation.kind === 'conversation') return { text: interpretation.reply };
    // R-22 AC1: the processor failed before anything was stored.
    if (interpretation.kind === 'failed') {
      logger.error('text not handled: the processor failed', {
        channelRef: message.channelRef,
        reason: interpretation.reason,
      });
      return { text: strings.processingFailed() };
    }
    if (interpretation.kind === 'invalid') {
      logger.warn('text not interpreted', {
        channelRef: message.channelRef,
        reason: interpretation.reason,
      });
      return unclearAmount();
    }

    const { inferences } = interpretation;

    // R-2 AC6: the amount must be one the principal wrote literally.
    const total = inferredValue(inferences, 'total');
    if (typeof total !== 'number' || total <= 0 || !isLiteralAmount(message.text, total)) {
      logger.warn('processor amount is not written in the message', {
        channelRef: message.channelRef,
        total,
      });
      return unclearAmount();
    }

    // R-2 AC7: today in TZ unless the processor inferred a named date; never a later one.
    let occurredOn = today;
    const inferredDate = inferredValue(inferences, 'occurred_on');
    if (inferredDate !== null) {
      if (typeof inferredDate === 'string' && isCalendarDate(inferredDate)) {
        occurredOn = inferredDate;
      } else {
        logger.warn('processor date is not a calendar date; using today', {
          channelRef: message.channelRef,
          occurred_on: inferredDate,
        });
      }
    }
    if (occurredOn > today) {
      return { text: await phrase(strings.futureDate(occurredOn), [formatDate(occurredOn)]) };
    }

    const merchant = textValue(inferredValue(inferences, 'merchant'));

    // R-2 AC3: a category counts as declared only if the principal actually wrote it.
    const statedCategory = textValue(inferredValue(inferences, 'declared_category'));
    const declaredCategory =
      statedCategory !== null && writtenIn(message.text, statedCategory)
        ? statedCategory.toLowerCase()
        : null;
    if (statedCategory !== null && declaredCategory === null) {
      logger.info('declared category not written in the message; ignored', {
        channelRef: message.channelRef,
        declared_category: statedCategory,
      });
    }

    const categorization = categorize({
      merchant: merchant ?? '',
      policies: listActivePolicies(db),
      categories,
      declaredCategory,
      suggestedCategory: textValue(inferredValue(inferences, 'category')),
    });
    if (categorization.missingDeclaredCategory !== null) {
      // R-18 AC3 asks S-15 here; that arrives in M4, so the expense stays uncategorized.
      logger.info('declared category does not exist; registered without a category', {
        channelRef: message.channelRef,
        category: categorization.missingDeclaredCategory,
      });
    }

    // R-2 AC2: the authority check is code; a text expense is authorized by the principal's own
    // message, so no permission is looked up.
    const authority = checkAuthority(
      { operation: 'register_expense', expense: { kind: 'text', declared_by: 'principal' } },
      { permissions: [], now: now() },
    );
    if (authority.decision !== 'execute' || !('authorized_by' in authority)) {
      throw new Error(`text expense not authorized: ${JSON.stringify(authority)}`);
    }

    // §10: only the inferences the expense rests on survive; the rest die with the execution.
    const used = [
      inferenceOf(inferences, 'total'),
      occurredOn === inferredDate ? inferenceOf(inferences, 'occurred_on') : undefined,
      merchant === null ? undefined : inferenceOf(inferences, 'merchant'),
      categorization.basis === 'inferred' ? inferenceOf(inferences, 'category') : undefined,
    ].filter((inference) => inference !== undefined);

    const { expenseId, actionId } = registerTextExpense(db, {
      total_cents: total,
      merchant,
      occurred_on: occurredOn,
      category: categorization.category,
      category_basis: categorization.basis,
      authorized_by: authority.authorized_by,
      channelRef: message.channelRef,
      receivedAt: message.receivedAt,
      declaredCategory,
      inferences: used,
      processorSource,
      now: now().toISOString(),
    });

    // R-9 AC1: the reply comes from the stored row, not from what was proposed.
    const stored = readExpense(db, expenseId);
    const text =
      stored.merchant === null
        ? await phrase(strings.registeredNoMerchant(stored.total_cents, stored.category), [
            formatAmount(stored.total_cents),
            stored.category ?? UNCATEGORIZED,
          ])
        : await phrase(strings.registered(stored.total_cents, stored.merchant, stored.category), [
            formatAmount(stored.total_cents),
            stored.merchant,
            stored.category ?? UNCATEGORIZED,
          ]);

    return {
      text,
      onDelivered: (delivery) => {
        if (!recordReplyDelivery(db, actionId, delivery, text, now().toISOString())) {
          logger.warn('reply delivery already recorded', { actionId });
        }
      },
    };
  };
};
