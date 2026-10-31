import type { Complete } from './text-interpreter.ts';

// R-22 AC2: every processor call has a timeout, so a model that does not answer never blocks
// later messages. The call is aborted through its signal and rejected here even if the provider
// ignores the signal; callers treat the rejection as a failed call.

export class ProcessorTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the processor did not answer within ${timeoutMs} ms (R-22 AC2)`);
    this.name = 'ProcessorTimeoutError';
  }
}

export const withTimeout =
  <M>(complete: Complete<M>, timeoutMs: number): Complete<M> =>
  (model, context) => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProcessorTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    return Promise.race([complete(model, context, controller.signal), timeout]).finally(() =>
      clearTimeout(timer),
    );
  };
