import { TURN_NOT_STARTED } from '@anomander/telegram';
import { describe, expect, it, vi } from 'vitest';
import { oneTurnAtATime, TurnNotStartedError } from '../../src/app/turns.ts';

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

// B84: what an input waits for before its turn, such as its setup check (`beforeTurn`).
describe('waiting before a turn (B84)', () => {
  it('inputs that wait for the same check take their turns in arrival order, and a turn queued meanwhile goes first, as before', async () => {
    const turns = oneTurnAtATime();
    const order: string[] = [];
    let answer = (): void => {};
    const check = new Promise<void>((resolveCheck) => {
      answer = resolveCheck;
    });
    const turn = turns.inTurn(async (name: string) => {
      order.push(name);
    });
    const guided = async (name: string) => {
      await turns.beforeTurn(check);
      return turn(name);
    };
    const a = guided('A');
    const b = guided('B');
    const press = turn('press');
    const c = guided('C');
    answer();
    await Promise.all([a, b, press, c]);
    expect(order).toEqual(['press', 'A', 'B', 'C']);
  });

  it('close refuses an input in its check at once, and the check failing later raises no unhandled rejection', async () => {
    const turns = oneTurnAtATime();
    let fail = (_error: Error): void => {};
    const check = new Promise<void>((_, reject) => {
      fail = reject;
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const waiting = turns.beforeTurn(check);
      turns.close();
      await expect(waiting).rejects.toBeInstanceOf(TurnNotStartedError);
      fail(new Error('check failed late'));
      const after = turns.beforeTurn(Promise.reject(new Error('late too')));
      await expect(after).rejects.toBeInstanceOf(TurnNotStartedError);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('while the turns are open, a check that fails gives its own error and one that passes gives its value', async () => {
    const turns = oneTurnAtATime();
    await expect(turns.beforeTurn(Promise.reject(new Error('own')))).rejects.toThrow('own');
    await expect(turns.beforeTurn(Promise.resolve(7))).resolves.toBe(7);
    // The finished checks hold no refusal: closing later refuses nothing more.
    turns.close();
    await turns.drained();
  });

  it('takes no turn lock: a check settles while a turn runs', async () => {
    const turns = oneTurnAtATime();
    let end = (): void => {};
    const running = turns.inTurn(
      () =>
        new Promise<void>((resolveTurn) => {
          end = resolveTurn;
        }),
    )(undefined);
    await expect(turns.beforeTurn(Promise.resolve('checked'))).resolves.toBe('checked');
    end();
    await running;
  });
});
