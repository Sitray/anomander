import { exitCodes } from '@anomander/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type Drainable, exitOnceWritten, reportCrashes } from '../src/crash.ts';

/** A stream whose writes are out only once `flush` is called. */
const slowStream = () => {
  const waiting: (() => void)[] = [];
  const stream: Drainable = {
    write: (_chunk, done) => {
      waiting.push(() => done());
      return false;
    },
  };
  return {
    stream,
    flush: () => {
      for (const done of waiting.splice(0)) done();
    },
  };
};

describe('exitOnceWritten', () => {
  it('B51: halts the daemon at once, and exits only once the log is out', () => {
    const { stream, flush } = slowStream();
    const order: string[] = [];
    const exit = exitOnceWritten(
      [stream],
      (code) => order.push(`exit ${code}`),
      5_000,
      () => order.push('halt'),
    );

    exit(exitCodes.botInUse);
    expect(order).toEqual(['halt']);
    flush();
    expect(order).toEqual(['halt', `exit ${exitCodes.botInUse}`]);
  });

  it('B51: halts once, however many times it is asked to exit', () => {
    const halt = vi.fn();
    const exited = vi.fn();
    const exit = exitOnceWritten([], exited, 5_000, halt);

    exit(exitCodes.failed);
    exit(exitCodes.alreadyRunning);

    expect(halt).toHaveBeenCalledTimes(1);
    expect(exited.mock.calls).toEqual([[exitCodes.failed]]);
  });

  it('B51: still exits when halting the daemon throws', () => {
    const exited = vi.fn();
    const exit = exitOnceWritten([], exited, 5_000, () => {
      throw new Error('the store is gone');
    });

    exit(exitCodes.failed);

    expect(exited.mock.calls).toEqual([[exitCodes.failed]]);
  });

  it('B84: waits for a halt that settles after the log is out, then exits with the same code', async () => {
    const { stream, flush } = slowStream();
    const order: string[] = [];
    let settleHalt = (): void => {};
    const exit = exitOnceWritten(
      [stream],
      (code) => order.push(`exit ${code}`),
      5_000,
      () => {
        order.push('halt');
        return new Promise<void>((resolveHalt) => {
          settleHalt = () => {
            order.push('halted');
            resolveHalt();
          };
        });
      },
    );

    exit(exitCodes.botInUse);
    flush();
    await Promise.resolve();
    expect(order).toEqual(['halt']);
    settleHalt();
    await vi.waitFor(() => expect(order).toEqual(['halt', 'halted', `exit ${exitCodes.botInUse}`]));
  });

  it('B84: a halt that fails still lets the exit go once the log is out', async () => {
    const exited = vi.fn();
    const exit = exitOnceWritten([], exited, 5_000, () =>
      Promise.reject(new Error('Telegram is unreachable')),
    );

    exit(exitCodes.failed);

    await vi.waitFor(() => expect(exited.mock.calls).toEqual([[exitCodes.failed]]));
  });

  it('B84: a halt that never settles still exits within the limit', () => {
    vi.useFakeTimers();
    try {
      const exited = vi.fn();
      const exit = exitOnceWritten([], exited, 100, () => new Promise<void>(() => {}));

      exit(exitCodes.failed);
      vi.advanceTimersByTime(99);
      expect(exited).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exited.mock.calls).toEqual([[exitCodes.failed]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a halt, still exits once a stream that never drains has waited its limit', () => {
    vi.useFakeTimers();
    try {
      const exited = vi.fn();
      const exit = exitOnceWritten([slowStream().stream], exited, 100);

      exit(exitCodes.failed);
      vi.advanceTimersByTime(99);
      expect(exited).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exited.mock.calls).toEqual([[exitCodes.failed]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reportCrashes', () => {
  it('logs the crash and exits with a failure', () => {
    const listeners = new Map<string, (error: unknown) => void>();
    const log = { error: vi.fn() };
    const exit = vi.fn();
    reportCrashes({ on: (event, listener) => listeners.set(event, listener) }, log, exit);

    listeners.get('uncaughtException')?.(new Error('boom'));

    expect(log.error).toHaveBeenCalledWith('anomander daemon crashed: uncaught exception', {
      error: new Error('boom'),
    });
    expect(exit.mock.calls).toEqual([[exitCodes.failed]]);
  });
});
