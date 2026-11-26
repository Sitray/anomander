import { TURN_NOT_STARTED } from '@anomander/telegram';
import { describe, expect, it } from 'vitest';
import { oneTurnAtATime } from '../../src/app/turns.ts';

/** A promise settled from outside. */
const pending = () => {
  let settle = (): void => {};
  const promise = new Promise<void>((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, settle };
};

// B82: once the turns close, one that never started is refused at once, with the code the
// Telegram bot reads to leave its message for after a crash's restart.
describe('the turns once closed (B82)', () => {
  it('refuse a waiting turn at once, typed, while the running one still runs', async () => {
    const turns = oneTurnAtATime();
    const running = pending();
    const ran: string[] = [];
    const first = turns.inTurn(async () => {
      ran.push('first');
      await running.promise;
      return 'first done';
    })(undefined);
    await expect.poll(() => ran).toEqual(['first']);
    const second = turns.inTurn(async () => {
      ran.push('second');
      return 'second done';
    })(undefined);

    turns.close();

    await expect(second).rejects.toMatchObject({
      code: TURN_NOT_STARTED,
      message: 'ANOMANDER is stopping: this turn did not start',
    });
    expect(ran).toEqual(['first']);
    running.settle();
    await expect(first).resolves.toBe('first done');
    await turns.drained();
    expect(ran).toEqual(['first']);
  });

  it('still run a turn that ends running work after the running one, as before', async () => {
    const turns = oneTurnAtATime();
    const running = pending();
    const ran: string[] = [];
    let firstStarted = false;
    const first = turns.inTurn(async () => {
      firstStarted = true;
      await running.promise;
      ran.push('first');
    })(undefined);
    await expect.poll(() => firstStarted).toBe(true);
    const ending = turns.inTurn(
      async () => {
        ran.push('ends');
      },
      { ends: true },
    )(undefined);

    turns.close();
    await Promise.resolve();
    expect(ran).toEqual([]);
    running.settle();
    await first;
    await ending;

    expect(ran).toEqual(['first', 'ends']);
  });
});
