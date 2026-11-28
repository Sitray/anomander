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

// DK-19: a processor call is stopped with its turn; only a call the stop overtook says so.
const ANSWER: AssistantMessage = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../fixtures/text-interpreter/conversation.json'),
    'utf8',
  ),
);
const CONTEXT: Context = { messages: [] };
const ignore = () => {};

/** Runs one call of `complete` in a stoppable turn of `controller`. */
const oneCall = (
  controller: AbortController,
  complete: (signal?: AbortSignal) => Promise<AssistantMessage>,
) =>
  runStoppable(controller.signal, ignore, async () => {
    const call = withCancel<string>((_model, _context, signal) => complete(signal));
    try {
      return { answer: await call('model', CONTEXT), stopped: turnStopped() };
    } catch (error) {
      return { error, stopped: turnStopped() };
    }
  });

describe('withCancel (DK-19)', () => {
  it('a call that answered before its turn was stopped keeps its answer and is not interrupted', async () => {
    const controller = new AbortController();

    const result = await oneCall(controller, () => {
      const answered = Promise.resolve(ANSWER);
      // The stop lands once the call answered, before the turn took the answer.
      void answered.then(() => controller.abort());
      return answered;
    });

    expect(result).toEqual({ answer: ANSWER, stopped: false });
  });

  it('a call that runs when its turn is stopped is rejected at once, and the turn says so', async () => {
    const controller = new AbortController();

    const result = await oneCall(controller, () => {
      setTimeout(() => controller.abort(), 0);
      return new Promise<AssistantMessage>(() => {});
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

  it('a call that fails by itself in a turn nobody stopped is not interrupted', async () => {
    const failure = new Error('provider down');

    const result = await oneCall(new AbortController(), () => Promise.reject(failure));

    expect(result).toEqual({ error: failure, stopped: false });
  });
});
