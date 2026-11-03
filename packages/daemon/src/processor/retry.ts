import { isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { Complete } from './text-interpreter.ts';

// R-22 AC3: a provider that is briefly overloaded or rate limited (a 503 or 429) usually answers
// a few seconds later, so such a call is retried twice, after 1 s and then 2 s, before it counts
// as failed. pi-ai classifies which errors are transient. Every retry is one more processor call
// against the daily AI budget (R-12): `mayRetry` consumes it, and no retry is made past it.

export const RETRIES = 2;
const BASE_DELAY_MS = 1000;

export interface RetryOptions {
  /** Counts the retry against the daily AI budget; `false` when the budget is spent. */
  mayRetry: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const withRetry =
  <M>(complete: Complete<M>, { mayRetry, sleep = pause, logger }: RetryOptions): Complete<M> =>
  async (model, context, signal) => {
    for (let attempt = 1; ; attempt++) {
      const response = await complete(model, context, signal);
      if (attempt > RETRIES || !isRetryableAssistantError(response) || !mayRetry()) {
        return response;
      }
      const delayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.warn('The processor had a transient error; retrying', { attempt, delayMs });
      await sleep(delayMs);
    }
  };
