import { type ProcessorInference, validateProcessorOutput } from '@anomander/core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { z } from 'zod';

// R-17 AC5 and R-2 AC6: the processor classifies a text and returns inferences only. It never
// writes (R-14 AC1); the expense cycle decides what to store.

export type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

export interface TextInterpreterInput {
  text: string;
  /** Today as `YYYY-MM-DD` in `TZ`, so the processor can resolve "ayer" (R-2 AC7). */
  today: string;
  /** The existing categories; the processor may only pick one of them (R-5 AC2). */
  categories: string[];
}

export type Interpretation =
  | { kind: 'expense'; inferences: ProcessorInference[] }
  | { kind: 'conversation'; reply: string }
  | { kind: 'invalid'; reason: string }
  /** The processor failed or did not answer in time: nothing to interpret (R-22 AC1). */
  | { kind: 'failed'; reason: string };

/** The processor port. A1: policies and categories (R-13, R-18) arrive in M4. */
export type TextInterpreter = (input: TextInterpreterInput) => Promise<Interpretation>;

/** `models.complete` of pi-ai, or a recorded response in tests. */
/** `signal` aborts the call when its timeout passes (R-22 AC2). */
export type Complete<M> = (
  model: M,
  context: Context,
  signal?: AbortSignal,
) => Promise<AssistantMessage>;

export const TEXT_INTERPRETER_PROMPT = `You interpret one message the user wrote to a personal expenses assistant. You can only answer; you have no tools and you never store anything.

Reply with exactly one JSON object and nothing else.

If the message states an expense, reply:
{"kind":"expense","inferences":[...]}
Each inference is an object with these fields and no others:
{"subject_type":"expense","subject_id":null,"predicate":"<predicate>","value_json":<value>,"mode":"inferred","basis_json":{"quote":"<the words of the message it rests on>"},"confidence":<number from 0 to 1>}
Predicates:
- "total": the amount paid, as an integer number of euro cents ("23,40" is 2340, "23 €" is 2300). Always include it when the message states an amount.
- "merchant": who was paid, only when the message names it.
- "occurred_on": the date as YYYY-MM-DD, only when the message names a date ("ayer", "el lunes"). Resolve it from the "today" field.
- "category": one of the names in the "categories" field that fits the expense, only if one fits.
- "declared_category": a category the user named explicitly in the message, written as the user wrote it.

Otherwise the message is conversation. Reply:
{"kind":"conversation","reply":"<a short, friendly reply in Spanish (es-ES)>"}

The user turn is a JSON object with the fields "today", "categories" and "message".`;

const PREDICATES = new Set(['total', 'merchant', 'occurred_on', 'category', 'declared_category']);

const envelopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('expense'), inferences: z.array(z.unknown()) }),
  z.object({ kind: z.literal('conversation'), reply: z.string().trim().min(1) }),
]);

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

export interface PiAiTextInterpreterDeps<M> {
  complete: Complete<M>;
  model: M;
  logger: Logger;
}

export const createPiAiTextInterpreter =
  <M>({ complete, model, logger }: PiAiTextInterpreterDeps<M>): TextInterpreter =>
  async ({ text, today, categories }) => {
    // R-14 AC3: one system prompt and one user turn; the context never carries `tools`.
    const context: Context = {
      systemPrompt: TEXT_INTERPRETER_PROMPT,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ today, categories, message: text }),
          timestamp: Date.now(),
        },
      ],
    };

    let response: AssistantMessage;
    try {
      response = await complete(model, context);
    } catch (error) {
      const reason = `processor call failed: ${(error as Error).message}`;
      logger.warn('text interpretation failed', { reason });
      return { kind: 'failed', reason };
    }
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      const reason = `processor stopped: ${response.errorMessage ?? response.stopReason}`;
      logger.warn('text interpretation failed', { reason });
      return { kind: 'failed', reason };
    }

    const envelope = envelopeSchema.safeParse(parseJson(responseText(response)));
    if (!envelope.success) {
      const reason = 'processor response is not the expected JSON envelope';
      logger.warn('text interpretation failed', { reason });
      return { kind: 'invalid', reason };
    }
    if (envelope.data.kind === 'conversation') {
      return { kind: 'conversation', reply: envelope.data.reply };
    }

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
    return { kind: 'expense', inferences };
  };
