import { exitCodes } from '@anomander/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type Drainable, exitOnceWritten } from '../../src/crash.ts';

// B53 (R3-002, R3-003): a stream whose last write fails, such as a pipe whose reader is gone
// (`EPIPE`), has nothing left to wait for: it does not hold the exit to the limit.
describe('exitOnceWritten with a stream that fails', () => {
  it('exits once the other streams are out, with the first code', () => {
    vi.useFakeTimers();
    try {
      let flush = (): void => {};
      const slow: Drainable = {
        write: (_chunk, done) => {
          flush = () => done();
          return false;
        },
      };
      const broken: Drainable = {
        write: (_chunk, done) => {
          setImmediate(() => done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
          return false;
        },
      };
      const exited = vi.fn();
      const exit = exitOnceWritten([broken, slow], exited, 5_000);

      exit(exitCodes.failed);
      exit(exitCodes.botInUse);
      vi.advanceTimersByTime(10);
      expect(exited).not.toHaveBeenCalled();
      flush();

      expect(exited.mock.calls).toEqual([[exitCodes.failed]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
