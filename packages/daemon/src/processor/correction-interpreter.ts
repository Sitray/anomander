import { validateProcessorOutput, weekdayOf } from '@anomander/core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { AiBudgetExhaustedError } from '../budget/ai-budget.ts';
import type { Complete, CorrectionInterpretation, CorrectionInterpreter, Logger } from './ports.ts';

export type {
  CorrectionInterpretation,
  CorrectionInterpreter,
  CorrectionInterpreterInput,
} from './ports.ts';

// R-7 AC2: the processor reads the principal's correction of one expense and points at the
// values written in it, as inferences only. It never writes (R-14 AC1); code accepts a value
// only if the principal actually wrote it.

/**
 * The correction interpreter's prompt. The new total is in the corrected expense's own currency,
 * given in its user turn, never the principal's: a stored expense keeps its currency (B87).
 */
export const correctionInterpreterPrompt =
  (): string => `You read one message in which the user corrects an expense that a personal assistant was about to record. You can only answer; you have no tools and you never store anything.

Reply with exactly one JSON object and nothing else:
{"kind":"correction","inferences":[...]}
Each inference is an object with these fields and no others:
{"subject_type":"expense","subject_id":null,"predicate":"<predicate>","value_json":<value>,"mode":"inferred","basis_json":{"quote":"<the words of the message it rests on>"},"confidence":<number from 0 to 1>}
Predicates, only for what the message changes:
- "total": the new amount paid, in the currency of the expense's "total" (its "currency"), as an integer number of hundredths of that currency ("28,40" is 2840).
- "merchant": the new merchant, written as the user wrote it.
- "category": the new category, written as the user wrote it.
- "occurred_on": the new purchase date as YYYY-MM-DD, resolved against "today" and "weekday".
If the message changes none of them, reply {"kind":"correction","inferences":[]}.

The user turn is a JSON object with the fields "expense" (the values being corrected), "categories", "today", "weekday" (the day of the week of "today") and "message".`;

const PREDICATES = new Set(['total', 'merchant', 'category', 'occurred_on']);

const envelopeSchema = z.object({
  kind: z.literal('correction'),
  inferences: z.array(z.unknown()),
});

const FENCED = /```(?:json)?\s*([\s\S]*?)```/;

const responseText = (message: AssistantMessage): string => {
  const text = message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  return FENCED.exec(text)?.[1]?.trim() ?? text;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export interface PiAiCorrectionInterpreterDeps<M> {
  complete: Complete<M>;
  model: M;
  logger: Logger;
}

export const createPiAiCorrectionInterpreter =
  <M>({ complete, model, logger }: PiAiCorrectionInterpreterDeps<M>): CorrectionInterpreter =>
  async ({ text, expense, categories, today }) => {
    const invalid = (reason: string): CorrectionInterpretation => {
      logger.warn('correction interpretation failed', { reason });
      return { kind: 'invalid', reason };
    };
    const failed = (reason: string): CorrectionInterpretation => {
      logger.warn('correction interpretation failed', { reason });
      return { kind: 'failed', reason };
    };
    // R-14 AC3: one system prompt and one user turn; the context never carries `tools`.
    const context: Context = {
      systemPrompt: correctionInterpreterPrompt(),
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            expense,
            categories,
            today,
            weekday: weekdayOf(today),
            message: text,
          }),
          timestamp: Date.now(),
        },
      ],
    };

    let response: AssistantMessage;
    try {
      response = await complete(model, context);
    } catch (error) {
      if (error instanceof AiBudgetExhaustedError) return { kind: 'budget_exhausted' };
      return failed(`processor call failed: ${(error as Error).message}`);
    }
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      return failed(`processor stopped: ${response.errorMessage ?? response.stopReason}`);
    }
    if (response.stopReason !== 'stop') {
      return invalid(`processor stopped: ${response.errorMessage ?? response.stopReason}`);
    }
    const envelope = envelopeSchema.safeParse(parseJson(responseText(response)));
    if (!envelope.success) return invalid('processor response is not the expected JSON envelope');

    // R-14 AC2: anything that is not a plain inference about the expense is rejected and logged.
    const { accepted, rejected } = validateProcessorOutput(envelope.data.inferences);
    const inferences = accepted.filter((inference) => {
      const known = inference.subject_type === 'expense' && PREDICATES.has(inference.predicate);
      if (!known) rejected.push({ item: inference, reason: 'unknown_subject_or_predicate' });
      return known;
    });
    // §16: a rejected item quotes the correction, so only its reason and predicate are logged.
    for (const { item, reason } of rejected) {
      const predicate = (item as { predicate?: unknown } | null)?.predicate;
      logger.warn('processor output rejected', {
        reason,
        predicate: typeof predicate === 'string' ? predicate : null,
      });
    }
    return { kind: 'correction', inferences };
  };
