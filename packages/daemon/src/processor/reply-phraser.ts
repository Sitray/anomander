import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type { Complete, Logger } from './text-interpreter.ts';

// R-21: the assistant words S-1, S-2, S-16 and S-21 in its own voice, and the text interpreter
// words S-36, but the facts come from code. The phrased text is sent only if it keeps every fact
// and adds none; otherwise the §12 string is sent unchanged.

export interface PhraseRequest {
  /** The §12 string: what the processor rewords, and the fallback (R-21 AC1, AC2). */
  reference: string;
  /** Facts read from the database, formatted as in §12, that the reply must contain. */
  facts: string[];
  /** The principal's message, so the reply can match its tone. */
  message: string;
}

/** Always resolves to a text that can be sent: the phrased one or the reference. */
export type ReplyPhraser = (request: PhraseRequest) => Promise<string>;

export const REPLY_PHRASER_PROMPT = `You word the replies of a personal assistant that talks to its user in Spanish (es-ES). You can only answer; you have no tools.

The user turn is a JSON object with "reference" (the reply to send), "facts" and "message" (what the user wrote).
Rewrite the reference as one short, warm reply in Spanish (es-ES) that says the same thing.
Copy every item of "facts" exactly as written. Do not add any other number, amount or date, and do not change what the reference says happened.
Reply with the text only, at most 280 characters.`;

const MAX_LENGTH = 280;

// Intl writes a no-break space before `€` and a model usually a plain one; `\s` matches both.
const normalize = (text: string): string => text.replace(/\s+/g, ' ').toLocaleLowerCase('es-ES');

// Numbers are compared as written, so `1.234,56` or `23.000` can never pass for another value.
const NUMBER = /\d(?:[\d.,]*\d)?/g;
const AMOUNT = /€\s*(\d(?:[\d.,]*\d)?)|(\d(?:[\d.,]*\d)?)\s*(?:€|euros?\b|eur\b)/giu;

const numbers = (text: string): Set<string> => new Set(text.match(NUMBER) ?? []);
const amounts = (text: string): Set<string> =>
  new Set([...text.matchAll(AMOUNT)].map((match) => match[1] ?? match[2] ?? ''));
const within = (found: Set<string>, allowed: Set<string>): boolean =>
  [...found].every((token) => allowed.has(token));

/**
 * R-21 AC2: every fact is there; every number and every amount in the reply already appears in
 * the facts or the reference (a date's day is a number, not an amount); short enough.
 */
const keepsTheFacts = (
  text: string,
  request: Pick<PhraseRequest, 'reference' | 'facts'>,
): boolean => {
  if (text === '' || text.length > MAX_LENGTH) return false;
  const phrased = normalize(text);
  if (!request.facts.every((fact) => phrased.includes(normalize(fact)))) return false;
  const supplied = normalize([request.reference, ...request.facts].join(' '));
  return within(numbers(phrased), numbers(supplied)) && within(amounts(phrased), amounts(supplied));
};

/**
 * R-21 AC2: the phrased text when it keeps the facts, otherwise the §12 string. Also for a reply
 * phrased in another processor call, such as S-36 in the text interpreter's (R-21 AC1).
 */
export const checkedPhrasing = (
  text: string | null,
  request: Pick<PhraseRequest, 'reference' | 'facts'>,
  logger: Logger,
): string => {
  // Never the text: a reply from the text interpreter may echo a memory or a recent turn (R-23 AC8).
  if (text === null) {
    logger.warn('no phrased reply; sending the §12 string', {});
    return request.reference;
  }
  if (!keepsTheFacts(text, request)) {
    logger.warn('phrased reply changed the facts; sending the §12 string', { length: text.length });
    return request.reference;
  }
  return text;
};

const responseText = (message: AssistantMessage): string =>
  message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();

export interface PiAiReplyPhraserDeps<M> {
  complete: Complete<M>;
  model: M;
  logger: Logger;
}

export const createPiAiReplyPhraser =
  <M>({ complete, model, logger }: PiAiReplyPhraserDeps<M>): ReplyPhraser =>
  async (request) => {
    // R-21 AC4: one system prompt and one user turn; the context never carries `tools`.
    const context: Context = {
      systemPrompt: REPLY_PHRASER_PROMPT,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            reference: request.reference,
            facts: request.facts,
            message: request.message,
          }),
          timestamp: Date.now(),
        },
      ],
    };

    let text: string;
    try {
      const response = await complete(model, context);
      // A cut-off ('length') or failed answer is not a reply: the §12 string goes out.
      if (response.stopReason !== 'stop') {
        logger.warn('reply phrasing failed; sending the §12 string', {
          reason: response.errorMessage ?? response.stopReason,
        });
        return request.reference;
      }
      text = responseText(response);
    } catch (error) {
      logger.warn('reply phrasing failed; sending the §12 string', {
        reason: (error as Error).message,
      });
      return request.reference;
    }

    return checkedPhrasing(text, request, logger);
  };

/** Sends the §12 string as it is: for tests and when no processor may be used. */
export const verbatimReplies: ReplyPhraser = async ({ reference }) => reference;
