import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProgressPhase } from '@anomander/protocol';
import type { Complete } from './ports.ts';

// DK-19 (docs/desktop-prd.md): a turn the principal can stop from the app. The local channel runs
// a `text`, `screen` or `connect` request inside a scope with its own signal; every processor call
// made for that turn, however deep, aborts when the signal does, and none starts after it. What
// was already written stays: only processor calls are stopped, never a write or a tool call that
// runs. Turns from Telegram run outside any scope and are never stopped.
//
// The scope also carries how the turn reports what it is doing (`reportPhase`), for the window.

export class TurnCancelledError extends Error {
  constructor() {
    super('the principal stopped this turn (DK-19)');
    this.name = 'TurnCancelledError';
  }
}

interface TurnScope {
  signal: AbortSignal;
  /** A processor call of this turn was stopped or refused. */
  interrupted: boolean;
  report: (phase: ProgressPhase) => void;
}

const scope = new AsyncLocalStorage<TurnScope>();

/** Runs `work` as a turn `signal` can stop, and whose phases go to `report`. */
export const runStoppable = <T>(
  signal: AbortSignal,
  report: (phase: ProgressPhase) => void,
  work: () => Promise<T>,
): Promise<T> => scope.run({ signal, interrupted: false, report }, work);

/** Whether a processor call of the running turn was stopped: its reply must say so (S-130). */
export const turnStopped = (): boolean => scope.getStore()?.interrupted ?? false;

/** Says what the running turn is doing now; nothing outside a stoppable turn. */
export const reportPhase = (phase: ProgressPhase): void => {
  try {
    scope.getStore()?.report(phase);
  } catch {
    // A phase is a courtesy: a window gone meanwhile never fails the turn.
  }
};

/**
 * The processor call, stopped with its turn: it is refused once the turn was stopped, and one
 * that runs is aborted and rejected at once, even if the provider ignores the signal.
 */
export const withCancel =
  <M>(complete: Complete<M>): Complete<M> =>
  (model, context, signal) => {
    const turn = scope.getStore();
    if (turn === undefined) return complete(model, context, signal);
    if (turn.signal.aborted) {
      turn.interrupted = true;
      return Promise.reject(new TurnCancelledError());
    }
    const both = signal === undefined ? turn.signal : AbortSignal.any([signal, turn.signal]);
    let stop: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => {
        turn.interrupted = true;
        reject(new TurnCancelledError());
      };
      turn.signal.addEventListener('abort', stop, { once: true });
    });
    return Promise.race([complete(model, context, both), stopped]).finally(() => {
      if (stop !== undefined) turn.signal.removeEventListener('abort', stop);
    });
  };
