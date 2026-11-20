import { isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { Complete } from './text-interpreter.ts';

// R-22 AC3: a provider that is briefly overloaded or rate limited (a 503 or 429) usually answers
// a few seconds later, so such a call is retried twice, after about 1 s and then 2 s, before it
// counts as failed. pi-ai classifies which errors are transient. Every retry is one more processor
// call against the daily AI budget (R-12): `mayRetry` consumes it, and no retry is made past it.
//
// Each wait is shortened by up to a quarter at random, so callers that failed together do not
// retry together. When the provider's error says how long to wait (`Retry-After`, in seconds or
// as an HTTP date), the retry waits at least that long; when it asks for longer than the last
// backoff step, the call is not retried at all and spends no budget.

export const RETRIES = 2;
const BASE_DELAY_MS = 1000;
/** The longest wait between two calls: the last backoff step. */
export const MAX_DELAY_MS = BASE_DELAY_MS * 2 ** (RETRIES - 1);
const JITTER = 0.25;

export interface RetryOptions {
  /** Counts the retry against the daily AI budget; `false` when the budget is spent. */
  mayRetry: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
  /** A number in [0, 1) that sets the jitter. Default `Math.random`. */
  random?: () => number;
  /** Milliseconds since the epoch, to read a `Retry-After` date. Default `Date.now`. */
  now?: () => number;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// pi-ai gives only the error's text, so a `Retry-After` is read from it: delay-seconds or an
// IMF-fixdate (RFC 9110 §10.2.3).
const RETRY_AFTER =
  /retry-after["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?|[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT)/i;

/** How long the provider asked to wait, in ms from `now`, or `undefined` when it did not say. */
const retryAfterMs = (errorMessage: string | undefined, now: number): number | undefined => {
  const value = RETRY_AFTER.exec(errorMessage ?? '')?.[1];
  if (value === undefined) return undefined;
  const ms = /^\d/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
};

export const withRetry =
  <M>(
    complete: Complete<M>,
    { mayRetry, sleep = pause, logger, random = Math.random, now = Date.now }: RetryOptions,
  ): Complete<M> =>
  async (model, context, signal) => {
    for (let attempt = 1; ; attempt++) {
      const response = await complete(model, context, signal);
      if (attempt > RETRIES || !isRetryableAssistantError(response)) return response;
      // Read before the budget: a provider that asks for a longer wait than this one takes is
      // not called again, and that costs no retry.
      const asked = retryAfterMs(response.errorMessage, now());
      if ((asked !== undefined && asked > MAX_DELAY_MS) || !mayRetry()) return response;
      const step = Math.round(BASE_DELAY_MS * 2 ** (attempt - 1) * (1 - JITTER * random()));
      const delayMs = Math.max(step, Math.round(asked ?? 0));
      logger.warn('The processor had a transient error; retrying', {
        attempt,
        delayMs,
        retryAfter: asked !== undefined,
        reason: response.errorMessage,
      });
      await sleep(delayMs);
    }
  };
