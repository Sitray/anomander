import { type DoorReply, strings } from '@anomander/protocol';
import type { Later } from '../connections/session.ts';
import { turnStopped } from '../processor/cancel.ts';

const STOPPING = 'ANOMANDER is stopping: this turn did not start';

/**
 * Runs the inputs of every front door one at a time, in the order they arrived: Telegram and the
 * desktop app are one conversation (DK-4 AC4), and two turns never interleave. Once `close` is
 * called no turn starts, except one that ends work already running (`ends`); `drained` settles
 * when every turn and every piece of work given to `track` has.
 */
export const oneTurnAtATime = () => {
  let last: Promise<unknown> = Promise.resolve();
  let closed = false;
  const running = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    running.add(work);
    const done = () => running.delete(work);
    work.then(done, done);
    return work;
  };
  const inTurn =
    <I, R>(handler: (input: I) => Promise<R>, { ends = false } = {}) =>
    (input: I): Promise<R> => {
      const turn = last.then(() => {
        if (closed && !ends) throw new Error(STOPPING);
        return handler(input);
      });
      last = turn.catch(() => {});
      return track(turn);
    };
  return {
    inTurn,
    track,
    close: () => {
      closed = true;
    },
    // Work may start more work, such as a turn that starts a task's step: wait until none is left.
    drained: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
};

/**
 * DK-19: a turn the principal stopped from the app says so (S-130), and that what was done stays:
 * its buttons and their delivery are kept, so an expense written before the stop can be undone.
 */
export const sayingStopped =
  <I, R extends { text: string }>(handler: (input: I) => Promise<R>) =>
  async (input: I): Promise<R> => {
    const reply = await handler(input);
    return turnStopped() ? { ...reply, text: strings.turnCancelled() } : reply;
  };

/** What a handler answers once its turn is over: a `Later` is waited for outside the turn. */
export const settled = async (answer: DoorReply | Later | null): Promise<DoorReply | null> =>
  answer !== null && 'later' in answer ? answer.later : answer;
