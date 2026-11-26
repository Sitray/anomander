import { type DoorReply, strings } from '@anomander/protocol';
import type { Later } from '../connections/session.ts';
import { turnStopped } from '../processor/cancel.ts';

const STOPPING = 'ANOMANDER is stopping: this turn did not start';

/**
 * B82: a turn refused because the turns closed before it started, so nothing of it ran. Its
 * `code` is `TURN_NOT_STARTED` of `@anomander/telegram`, which a crash halt reads to leave the
 * message for Telegram to hand over again; this module does not load the bot to name it.
 */
export class TurnNotStartedError extends Error {
  readonly code = 'ANOMANDER_TURN_NOT_STARTED';
  constructor() {
    super(STOPPING);
    this.name = 'TurnNotStartedError';
  }
}

/**
 * Runs the inputs of every front door one at a time, in the order they arrived: Telegram and the
 * desktop app are one conversation (DK-4 AC4), and two turns never interleave. Once `close` is
 * called no turn starts, except one that ends work already running (`ends`): one that waits is
 * refused at once with `TurnNotStartedError` (B82), and so is an input still in `beforeTurn`
 * (B84). `drained` settles when every turn and every piece of work given to `track` has.
 */
export const oneTurnAtATime = () => {
  let last: Promise<unknown> = Promise.resolve();
  let closed = false;
  /** B82: how to refuse each turn that waits, not started yet. */
  const waiting = new Set<() => void>();
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
      let refuse = (): void => {};
      const refused = new Promise<never>((_, reject) => {
        refuse = () => reject(new TurnNotStartedError());
      });
      if (!ends) waiting.add(refuse);
      const turn = last.then(() => {
        waiting.delete(refuse);
        if (closed && !ends) throw new TurnNotStartedError();
        return handler(input);
      });
      // The order holds whatever the caller is told: the next turn still waits for this one.
      last = turn.catch(() => {});
      track(turn).catch(() => {});
      return ends ? turn : Promise.race([turn, refused]);
    };
  /**
   * B84: what an input waits for before it takes its turn, such as its setup check, which runs off
   * the turn lock (T14). Once `close` is called, the input is refused at once with
   * `TurnNotStartedError`, as a turn that waits, however long `work` still takes; `work` itself
   * is neither stopped nor run again.
   */
  const beforeTurn = <T>(work: Promise<T>): Promise<T> => {
    if (closed) {
      work.catch(() => {});
      return Promise.reject(new TurnNotStartedError());
    }
    let refuse = (): void => {};
    const refused = new Promise<never>((_, reject) => {
      refuse = () => reject(new TurnNotStartedError());
    });
    waiting.add(refuse);
    const done = () => waiting.delete(refuse);
    work.then(done, done);
    return Promise.race([work, refused]);
  };
  return {
    inTurn,
    beforeTurn,
    track,
    close: () => {
      closed = true;
      for (const refuseOne of waiting) refuseOne();
      waiting.clear();
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
