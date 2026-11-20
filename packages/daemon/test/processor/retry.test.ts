import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../../src/processor/retry.ts';

// R-22 AC3: a transient provider error is retried twice with backoff; each retry counts against
// the daily AI budget (R-12) and none is made past it.
const CONVERSATION: AssistantMessage = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../fixtures/text-interpreter/conversation.json'),
    'utf8',
  ),
);
const answer = (text: string): AssistantMessage => ({
  ...CONVERSATION,
  content: [{ type: 'text', text }],
});
const failure = (errorMessage: string): AssistantMessage => ({
  ...CONVERSATION,
  content: [],
  stopReason: 'error',
  errorMessage,
});
const UNAVAILABLE = failure('{"error":{"code":503,"status":"Service Unavailable"}}');
const quiet = { warn: () => {} };

const retried = (
  responses: AssistantMessage[],
  mayRetry = () => true,
  more: { random?: () => number; now?: () => number } = { random: () => 0 },
) => {
  const complete = vi.fn(async () => responses.shift() ?? answer('unexpected call'));
  const sleep = vi.fn(async (_ms: number) => {});
  return {
    complete,
    sleep,
    call: withRetry(complete, { mayRetry, sleep, logger: quiet, ...more }),
  };
};

describe('withRetry', () => {
  it('retries a transient error twice, waiting 1 s then 2 s, and returns the first answer', async () => {
    const { complete, sleep, call } = retried([UNAVAILABLE, UNAVAILABLE, answer('ok')]);

    expect(await call('model', { messages: [] })).toEqual(answer('ok'));
    expect(complete).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);

    const exhausted = retried([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, answer('late')]);
    expect(await exhausted.call('model', { messages: [] })).toEqual(UNAVAILABLE);
    expect(exhausted.complete).toHaveBeenCalledTimes(3);
  });

  it('shortens each wait by up to a quarter, at random, so callers do not retry in step', async () => {
    const half = retried([UNAVAILABLE, UNAVAILABLE, answer('ok')], () => true, {
      random: () => 0.5,
    });
    expect(await half.call('model', { messages: [] })).toEqual(answer('ok'));
    expect(half.sleep.mock.calls).toEqual([[875], [1750]]);

    // Unseeded, a wait stays between three quarters of its step and the step itself.
    for (let run = 0; run < 20; run++) {
      const plain = retried([UNAVAILABLE, UNAVAILABLE, answer('ok')], () => true, {});
      await plain.call('model', { messages: [] });
      const [first, second] = plain.sleep.mock.calls.map(([ms]) => ms);
      expect(first).toBeGreaterThanOrEqual(750);
      expect(first).toBeLessThanOrEqual(1000);
      expect(second).toBeGreaterThanOrEqual(1500);
      expect(second).toBeLessThanOrEqual(2000);
      expect(plain.complete).toHaveBeenCalledTimes(3);
    }
  });

  it("waits as long as the provider's Retry-After says, in seconds or as a date", async () => {
    const now = Date.parse('Fri, 20 Nov 2026 10:00:00 GMT');
    const { complete, sleep, call } = retried(
      [
        failure('429 Too Many Requests (Retry-After: 2)'),
        failure('503 Service Unavailable; retry-after: Fri, 20 Nov 2026 10:00:02 GMT'),
        answer('ok'),
      ],
      () => true,
      { random: () => 0.5, now: () => now },
    );

    expect(await call('model', { messages: [] })).toEqual(answer('ok'));
    expect(complete).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2000], [2000]]);
  });

  it('never retries sooner than its own step, even when Retry-After is already past', async () => {
    const now = Date.parse('Fri, 20 Nov 2026 10:00:00 GMT');
    const { sleep, call } = retried(
      [
        failure('503 Service Unavailable; Retry-After: Fri, 20 Nov 2026 09:59:00 GMT'),
        failure('429 Too Many Requests (Retry-After: 0)'),
        answer('ok'),
      ],
      () => true,
      { random: () => 0.5, now: () => now },
    );

    expect(await call('model', { messages: [] })).toEqual(answer('ok'));
    expect(sleep.mock.calls).toEqual([[875], [1750]]);
  });

  it('gives up, spending no budget, when Retry-After asks for longer than its last step', async () => {
    const now = Date.parse('Fri, 20 Nov 2026 10:00:00 GMT');
    for (const late of [
      failure('429 Too Many Requests (Retry-After: 120)'),
      failure('503 Service Unavailable; Retry-After: Fri, 20 Nov 2026 10:01:00 GMT'),
    ]) {
      const mayRetry = vi.fn(() => true);
      const { complete, sleep, call } = retried([late, answer('ok')], mayRetry, {
        random: () => 0,
        now: () => now,
      });

      expect(await call('model', { messages: [] })).toEqual(late);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(mayRetry).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it('makes no retry the budget does not allow', async () => {
    const { complete, call } = retried([UNAVAILABLE, answer('ok')], () => false);

    expect(await call('model', { messages: [] })).toEqual(UNAVAILABLE);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error that is not transient', async () => {
    const invalid = failure('400 INVALID_ARGUMENT: bad request');
    const { complete, call } = retried([invalid, answer('ok')]);

    expect(await call('model', { messages: [] })).toEqual(invalid);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
