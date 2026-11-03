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

const retried = (responses: AssistantMessage[], mayRetry = () => true) => {
  const complete = vi.fn(async () => responses.shift() ?? answer('unexpected call'));
  const sleep = vi.fn(async () => {});
  return { complete, sleep, call: withRetry(complete, { mayRetry, sleep, logger: quiet }) };
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
