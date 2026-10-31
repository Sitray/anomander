import { isCalendarDate, type ProcessorInference, validateProcessorOutput } from '@anomander/core';
import type { AssistantMessage, Context, ImageContent } from '@earendil-works/pi-ai';
import { z } from 'zod';
import type { Complete, Logger } from './text-interpreter.ts';

// PRD §10 step 2 and R-3 AC2: the vision processor reads a receipt and returns inferences only.
// It never writes (R-14 AC1) and gets no tools (R-14 AC3); the receipt cycle decides what to
// store.

export interface ReceiptReaderImage {
  mimeType: string;
  data: Uint8Array;
}

export interface ReceiptReaderInput {
  /** Every image of the receipt, read together in one call (R-3 AC4). */
  images: readonly ReceiptReaderImage[];
  /** The principal's caption, a declaration sent with the images (R-3 AC5). */
  caption: string | null;
  /** Today as `YYYY-MM-DD` in `TZ`. */
  today: string;
  /** The existing categories; the processor may only pick one of them (R-5 AC2). */
  categories: string[];
}

export interface ReceiptLine {
  name: string;
  quantity: number;
  amount_cents: number;
}

/** A validated inference and its typed value. */
export interface Inferred<T> {
  inference: ProcessorInference;
  value: T;
}

export interface ReceiptRead {
  kind: 'read';
  merchant: Inferred<string>;
  occurredOn: Inferred<string>;
  total: Inferred<number>;
  lines: Inferred<ReceiptLine>[];
  category: Inferred<string> | null;
  /** Read from the caption, not from the receipt (R-3 AC5). */
  declaredCategory: Inferred<string> | null;
  declaredMerchant: Inferred<string> | null;
}

export type ReceiptReading = ReceiptRead | { kind: 'unreadable'; reason: string };

/** The vision processor port. */
export type ReceiptReader = (input: ReceiptReaderInput) => Promise<ReceiptReading>;

export const RECEIPT_READER_PROMPT = `You read the images of one shop receipt for a personal assistant. You can only answer; you have no tools and you never store anything.

Reply with exactly one JSON object and nothing else.

If you can read the receipt, reply:
{"kind":"receipt","inferences":[...]}
Each inference is an object with these fields and no others:
{"subject_type":"expense","subject_id":null,"predicate":"<predicate>","value_json":<value>,"mode":"inferred","basis_json":{"quote":"<the printed text it rests on>"},"confidence":<number from 0 to 1>}
Predicates:
- "merchant": the business name printed on the receipt. Exactly one.
- "occurred_on": the purchase date as YYYY-MM-DD. Exactly one.
- "total": the total paid, as an integer number of euro cents ("23,40" is 2340). Exactly one.
- "line": one per product line, in printed order, with value {"name":"<as printed>","quantity":<number>,"amount_cents":<integer cents of the whole line>}.
- "category": one of the names in the "categories" field that fits the expense, only if one fits.
- "declared_category": a category the user named in the "caption" field, written as the user wrote it.
- "declared_merchant": a merchant the user named in the "caption" field, written as the user wrote it.
Copy the numbers as printed; never correct them so that the lines add up.

If the images are not a receipt, or you cannot read its merchant, date, total and lines, reply:
{"kind":"unreadable"}

The user turn is a JSON object with the fields "today", "categories" and "caption", followed by the images.`;

const nonEmpty = z.string().trim().min(1);
const valueSchemas = {
  merchant: nonEmpty,
  occurred_on: z.string().refine(isCalendarDate, 'not a calendar date'),
  total: z.int().positive(),
  line: z.strictObject({
    name: nonEmpty,
    quantity: z.number().positive(),
    // A discount line can be negative.
    amount_cents: z.int(),
  }),
  category: nonEmpty,
  declared_category: nonEmpty,
  declared_merchant: nonEmpty,
} as const;
type Predicate = keyof typeof valueSchemas;
const isPredicate = (predicate: string): predicate is Predicate => predicate in valueSchemas;

const envelopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('receipt'), inferences: z.array(z.unknown()) }),
  z.object({ kind: z.literal('unreadable') }),
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

const unreadable = (reason: string): ReceiptReading => ({ kind: 'unreadable', reason });

/**
 * R-3 AC2: every inference must be valid, the value of each predicate must have its shape, and
 * merchant, date, total and at least one line must be there. Anything else is unreadable.
 */
const toReading = (items: readonly unknown[], logger: Logger): ReceiptReading => {
  const { accepted, rejected } = validateProcessorOutput(items);
  // R-14 AC2: rejected and logged; a receipt with an invalid item is not trusted at all.
  for (const { item, reason } of rejected)
    logger.warn('processor output rejected', { reason, item });
  if (rejected.length > 0) return unreadable('processor output rejected');

  const found = new Map<Predicate, Inferred<unknown>[]>();
  for (const inference of accepted) {
    if (inference.subject_type !== 'expense' || !isPredicate(inference.predicate)) {
      logger.info('processor inference ignored', { predicate: inference.predicate });
      continue;
    }
    const value = valueSchemas[inference.predicate].safeParse(inference.value_json);
    if (!value.success) {
      logger.warn('processor output rejected', { reason: 'invalid_value', item: inference });
      return unreadable(`invalid ${inference.predicate}`);
    }
    found.set(inference.predicate, [
      ...(found.get(inference.predicate) ?? []),
      { inference, value: value.data },
    ]);
  }

  for (const [predicate, all] of found) {
    if (predicate !== 'line' && all.length > 1) return unreadable(`more than one ${predicate}`);
  }
  const one = <T>(predicate: Predicate) =>
    (found.get(predicate)?.[0] ?? null) as Inferred<T> | null;
  const merchant = one<string>('merchant');
  const occurredOn = one<string>('occurred_on');
  const total = one<number>('total');
  const lines = (found.get('line') ?? []) as Inferred<ReceiptLine>[];
  if (merchant === null || occurredOn === null || total === null || lines.length === 0) {
    return unreadable('merchant, date, total or lines missing');
  }
  return {
    kind: 'read',
    merchant,
    occurredOn,
    total,
    lines,
    category: one('category'),
    declaredCategory: one('declared_category'),
    declaredMerchant: one('declared_merchant'),
  };
};

export interface PiAiReceiptReaderDeps<M> {
  complete: Complete<M>;
  /** `ANOMANDER_VISION_MODEL` (R-15 AC1). */
  model: M;
  logger: Logger;
}

export const createPiAiReceiptReader =
  <M>({ complete, model, logger }: PiAiReceiptReaderDeps<M>): ReceiptReader =>
  async ({ images, caption, today, categories }) => {
    const imageBlocks: ImageContent[] = images.map(({ mimeType, data }) => ({
      type: 'image',
      mimeType,
      data: Buffer.from(data).toString('base64'),
    }));
    // R-14 AC3: one system prompt and one user turn with text and images; never `tools`.
    const context: Context = {
      systemPrompt: RECEIPT_READER_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: JSON.stringify({ today, categories, caption }) },
            ...imageBlocks,
          ],
          timestamp: Date.now(),
        },
      ],
    };

    const fail = (reason: string) => {
      logger.warn('receipt reading failed', { reason });
      return unreadable(reason);
    };
    let response: AssistantMessage;
    try {
      response = await complete(model, context);
    } catch (error) {
      return fail(`processor call failed: ${(error as Error).message}`);
    }
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      return fail(`processor stopped: ${response.errorMessage ?? response.stopReason}`);
    }
    const envelope = envelopeSchema.safeParse(parseJson(responseText(response)));
    if (!envelope.success) return fail('processor response is not the expected JSON envelope');
    if (envelope.data.kind === 'unreadable') return unreadable('the processor could not read it');
    return toReading(envelope.data.inferences, logger);
  };
