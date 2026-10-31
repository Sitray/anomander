import { type ProcessorInference, validateProcessorOutput } from '@anomander/core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { AiBudgetExhaustedError } from '../budget/ai-budget.ts';
import type { Complete, Logger } from './text-interpreter.ts';

// R-7 AC2: the processor reads the principal's correction of one expense and points at the
// values written in it, as inferences only. It never writes (R-14 AC1); code accepts a value
// only if the principal actually wrote it.

export interface CorrectionInterpreterInput {
  text: string;
  /** The expense being corrected, as stored. */
  expense: { total_cents: number; merchant: string | null; category: string | null };
  categories: string[];
}

export type CorrectionInterpretation =
  | { kind: 'correction'; inferences: ProcessorInference[] }
  | { kind: 'invalid'; reason: string }
  /** The processor failed or did not answer in time (R-22 AC1). */
  | { kind: 'failed'; reason: string }
  /** The daily AI budget is spent, so the processor was not called (R-12 AC4). */
  | { kind: 'budget_exhausted' };

export type CorrectionInterpreter = (
  input: CorrectionInterpreterInput,
) => Promise<CorrectionInterpretation>;

export const CORRECTION_INTERPRETER_PROMPT = `You read one message in which the user corrects an expense that a personal expenses assistant was about to record. You can only answer; you have no tools and you never store anything.

Reply with exactly one JSON object and nothing else:
{"kind":"correction","inferences":[...]}
Each inference is an object with these fields and no others:
{"subject_type":"expense","subject_id":null,"predicate":"<predicate>","value_json":<value>,"mode":"inferred","basis_json":{"quote":"<the words of the message it rests on>"},"confidence":<number from 0 to 1>}
Predicates, only for what the message changes:
- "total": the new amount paid, as an integer number of euro cents ("28,40" is 2840).
- "merchant": the new merchant, written as the user wrote it.
- "category": the new category, written as the user wrote it.
If the message changes none of them, reply {"kind":"correction","inferences":[]}.

The user turn is a JSON object with the fields "expense" (the values being corrected), "categories" and "message".`;

const PREDICATES = new Set(['total', 'merchant', 'category']);

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
  async ({ text, expense, categories }) => {
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
      systemPrompt: CORRECTION_INTERPRETER_PROMPT,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ expense, categories, message: text }),
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
    for (const { item, reason } of rejected) {
      logger.warn('processor output rejected', { reason, item });
    }
    return { kind: 'correction', inferences };
  };
