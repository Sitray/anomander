import { type ProcessorInference, validateProcessorOutput } from '@anomander/core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { AiBudgetExhaustedError } from '../budget/ai-budget.ts';
import type { RecentTurn } from '../conversation/recent-turns.ts';
import { type Memory, quotedFrom } from '../store/memory.ts';

// R-17 AC5 and R-2 AC6: the processor classifies a text and returns inferences only. It never
// writes (R-14 AC1); the expense cycle decides what to store.

export type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

export interface TextInterpreterInput {
  text: string;
  /** Today as `YYYY-MM-DD` in `TZ`, so the processor can resolve "ayer" (R-2 AC7). */
  today: string;
  /** The existing categories; the processor may only pick one of them (R-5 AC2). */
  categories: string[];
  /** The recent turns, oldest first (R-16 AC3). */
  recent: RecentTurn[];
  /** The current memories, for conversation replies only (R-23 AC4). */
  memories: Memory[];
}

/** A lasting fact about the principal the processor found in the message (R-23 AC1). */
export interface MemoryFact {
  text: string;
  /** The words of the message it rests on. */
  quote: string;
  /** Whether the principal said it; code still checks the quote before calling it declared. */
  said: boolean;
  confidence: number;
  /** The id of the current memory it replaces (R-23 AC3). */
  replaces: number | null;
}

export type Interpretation =
  | { kind: 'expense'; inferences: ProcessorInference[]; memories: MemoryFact[] }
  | { kind: 'conversation'; reply: string; memories: MemoryFact[] }
  | { kind: 'invalid'; reason: string }
  /** The processor failed or did not answer in time: nothing to interpret (R-22 AC1). */
  | { kind: 'failed'; reason: string }
  /** The daily AI budget is spent, so the processor was not called (R-12 AC4). */
  | { kind: 'budget_exhausted' };

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

Either reply may also carry "memories": lasting facts about the user found in "message", such as "soy vegetariano" or "vivo en Madrid", never passing states such as "tengo hambre". Each memory is an object with these fields and no others:
{"text":"<the fact, short, in Spanish>","quote":"<the words of the message it rests on>","said":<true if the user stated it, false if you deduced it>,"confidence":<number from 0 to 1>,"replaces":<the id of a listed memory it contradicts, or null>}
Leave "memories" out when the message holds no lasting fact.

The user turn is a JSON object with the fields "today", "categories", "recent", "memories" and "message". "recent" lists the previous turns of this conversation, oldest first, each with what the user wrote ("principal") and what you answered ("reply"); use it to understand references such as "ese" or "lo de antes". "memories" lists what you remember about the user, each with its "id", "text" and "mode"; use them only to shape a conversation reply, never as the source of an expense inference: every expense quote must be words of "message". Interpret only "message".`;

const PREDICATES = new Set(['total', 'merchant', 'occurred_on', 'category', 'declared_category']);

const envelopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('expense'),
    inferences: z.array(z.unknown()),
    memories: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('conversation'),
    reply: z.string().trim().min(1),
    memories: z.unknown().optional(),
  }),
]);

const memoryFactSchema = z.strictObject({
  text: z.string().trim().min(1),
  quote: z.string().trim().min(1),
  said: z.boolean(),
  confidence: z.number().min(0).max(1),
  replaces: z.int().positive().nullable().optional(),
});

// R-23 AC1, AC8: invalid facts are dropped and logged by field and issue code only, never with
// their text or quote.
const memoryFactsOf = (raw: unknown, logger: Logger): MemoryFact[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logger.warn('processor memory rejected', { reason: 'invalid:memories not_an_array' });
    return [];
  }
  return raw.flatMap((item) => {
    const parsed = memoryFactSchema.safeParse(item);
    if (parsed.success) return [{ ...parsed.data, replaces: parsed.data.replaces ?? null }];
    const issue = parsed.error.issues[0];
    const reason = issue ? `${issue.path.join('.') || '(root)'} ${issue.code}` : 'unknown';
    logger.warn('processor memory rejected', { reason: `invalid:${reason}` });
    return [];
  });
};

const quoteOf = (inference: ProcessorInference): unknown => {
  const basis = inference.basis_json;
  return typeof basis === 'object' && basis !== null && !Array.isArray(basis)
    ? basis.quote
    : undefined;
};

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
  async ({ text, today, categories, recent, memories }) => {
    // R-14 AC3: one system prompt and one user turn; the context never carries `tools`.
    const context: Context = {
      systemPrompt: TEXT_INTERPRETER_PROMPT,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ today, categories, recent, memories, message: text }),
          timestamp: Date.now(),
        },
      ],
    };

    let response: AssistantMessage;
    try {
      response = await complete(model, context);
    } catch (error) {
      if (error instanceof AiBudgetExhaustedError) return { kind: 'budget_exhausted' };
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
    const facts = memoryFactsOf(envelope.data.memories, logger);
    if (envelope.data.kind === 'conversation') {
      return { kind: 'conversation', reply: envelope.data.reply, memories: facts };
    }

    // R-14 AC2: anything that is not a plain inference about the expense is rejected and logged.
    const { accepted, rejected } = validateProcessorOutput(envelope.data.inferences);
    const inferences = accepted.filter((inference) => {
      const known = inference.subject_type === 'expense' && PREDICATES.has(inference.predicate);
      if (!known) rejected.push({ item: inference, reason: 'unknown_subject_or_predicate' });
      return known;
    });
    // R-23 AC8: a rejected item may echo a memory's text, so only its predicate is logged.
    for (const { item, reason } of rejected) {
      const predicate = (item as { predicate?: unknown } | null)?.predicate;
      logger.warn('processor output rejected', {
        reason,
        predicate: typeof predicate === 'string' ? predicate : null,
      });
    }
    // R-23 AC4: an expense rests on the message alone, so neither a memory nor a recent turn can
    // become an expense fact. Logged without the item: its quote could be a memory's text (AC8).
    const quoted = inferences.filter((inference) => {
      const quote = quoteOf(inference);
      const inMessage = typeof quote === 'string' && quotedFrom(quote, text);
      if (!inMessage) {
        logger.warn('processor output rejected', {
          reason: 'quote_not_in_message',
          predicate: inference.predicate,
        });
      }
      return inMessage;
    });
    return { kind: 'expense', inferences: quoted, memories: facts };
  };
