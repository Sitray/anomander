import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
  runStoppable,
  TurnCancelledError,
  turnStopped,
  withCancel,
} from '../../src/processor/cancel.ts';

// DK-19, B76: a processor call is stopped with its turn; only a call the stop overtook says so.
const ANSWER: AssistantMessage = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../fixtures/text-interpreter/conversation.json'),
    'utf8',
  ),
);
const CONTEXT: Context = { messages: [] };
const ignore = () => {};

type Provider = (signal?: AbortSignal) => Promise<AssistantMessage>;

/**
 * Runs `body` as a stoppable turn of `controller`, with a processor call that asks `provider`;
 * its result or error, and whether the turn then says it was stopped.
 */
const inTurn = <T>(
  controller: AbortController,
  provider: Provider,
  body: (call: () => Promise<AssistantMessage>) => Promise<T>,
) =>
  runStoppable(controller.signal, ignore, async () => {
    const complete = withCancel<string>((_model, _context, signal) => provider(signal));
    try {
      return { value: await body(() => complete('model', CONTEXT)), stopped: turnStopped() };
    } catch (error) {
      return { error, stopped: turnStopped() };
    }
  });

/** One call in a turn of `controller`. */
const oneCall = (controller: AbortController, provider: Provider) =>
  inTurn(controller, provider, (call) => call());

describe('withCancel (DK-19)', () => {
  it('a call that answered before its turn was stopped keeps its answer and is not interrupted', async () => {
    const controller = new AbortController();

    const result = await oneCall(controller, () => {
      const answered = Promise.resolve(ANSWER);
      // The stop lands once the call answered, before the turn took the answer.
      void answered.then(() => controller.abort());
      return answered;
    });

    expect(result).toEqual({ value: ANSWER, stopped: false });
  });

  it('a stop right after the provider answered at once keeps the answer', async () => {
    const controller = new AbortController();

    const result = await inTurn(
      controller,
      () => Promise.resolve(ANSWER),
      (call) => {
        const answered = call();
        controller.abort();
        return answered;
      },
    );

    expect(result).toEqual({ value: ANSWER, stopped: false });
  });

  it('a call that runs when its turn is stopped is rejected at once, even if the provider answers after', async () => {
    const controller = new AbortController();

    const result = await oneCall(controller, (signal) => {
      setTimeout(() => controller.abort(), 0);
      return new Promise((answer) =>
        signal?.addEventListener('abort', () => answer({ ...ANSWER, stopReason: 'aborted' })),
      );
    });

    expect(result).toEqual({ error: expect.any(TurnCancelledError), stopped: true });
  });

  it('a call made after its turn was stopped is refused, and the turn says so', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;

    const result = await oneCall(controller, async () => {
      called = true;
      return ANSWER;
    });

    expect(called).toBe(false);
    expect(result).toEqual({ error: expect.any(TurnCancelledError), stopped: true });
  });

  it('a stop after the turn took an answer refuses its next call and marks the turn', async () => {
    const controller = new AbortController();

    const result = await inTurn(
      controller,
      async () => ANSWER,
      async (call) => {
        const first = await call();
        const before = turnStopped();
        controller.abort();
        const second = await call().catch((error: unknown) => error);
        return { first, before, refused: second instanceof TurnCancelledError };
      },
    );

    expect(result).toEqual({
      value: { first: ANSWER, before: false, refused: true },
      stopped: true,
    });
  });

  it('a stop after the turn took its last answer leaves the turn unmarked', async () => {
    const controller = new AbortController();

    const result = await inTurn(
      controller,
      async () => ANSWER,
      async (call) => {
        const answer = await call();
        controller.abort();
        return answer;
      },
    );

    expect(result).toEqual({ value: ANSWER, stopped: false });
  });

  it('a call that fails while its turn is being stopped marks the turn', async () => {
    const controller = new AbortController();
    const failure = new Error('provider down');

    const result = await oneCall(controller, () => {
      const failed = Promise.reject(failure);
      failed.catch(() => controller.abort());
      return failed;
    });

    expect(result.stopped).toBe(true);
  });

  it('a call that fails by itself in a turn nobody stopped is not interrupted', async () => {
    const failure = new Error('provider down');

    const result = await oneCall(new AbortController(), () => Promise.reject(failure));

    expect(result).toEqual({ error: failure, stopped: false });
  });

  it('leaves a call outside a stoppable turn as it is', async () => {
    const complete = withCancel<string>(async () => ANSWER);

    await expect(complete('model', CONTEXT)).resolves.toEqual(ANSWER);
    expect(turnStopped()).toBe(false);
  });
});
