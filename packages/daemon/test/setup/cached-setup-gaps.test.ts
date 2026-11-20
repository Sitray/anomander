import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cachedSetupGaps,
  SETUP_CHECK_CACHE_MS,
  SETUP_CHECK_TIMEOUT_MS,
  type SetupGap,
} from '../../src/setup/setup-guide.ts';

// T14 (engineering audit): the connection check of R-28 AC4 runs on every message, so it is
// bounded by a timeout and a complete setup is not checked again for 30 seconds.
const GAP: SetupGap = { kind: 'provider_unconnected', providerId: 'openai' };

afterEach(() => {
  vi.useRealTimers();
});

describe('cachedSetupGaps', () => {
  it('keeps a complete setup for 30 seconds, and checks again after', async () => {
    let clock = 0;
    const check = vi.fn(async (): Promise<readonly SetupGap[]> => []);
    const gaps = cachedSetupGaps({ check, now: () => clock, logger: { warn: vi.fn() } });

    expect(await gaps()).toEqual([]);
    clock += SETUP_CHECK_CACHE_MS - 1;
    expect(await gaps()).toEqual([]);
    expect(check).toHaveBeenCalledTimes(1);

    clock += 1;
    expect(await gaps()).toEqual([]);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('checks a gap again on every call, as before, so a login completes setup at once', async () => {
    let connected = false;
    const check = vi.fn(async (): Promise<readonly SetupGap[]> => (connected ? [] : [GAP]));
    const gaps = cachedSetupGaps({ check, now: () => 0, logger: { warn: vi.fn() } });

    expect(await gaps()).toEqual([GAP]);
    expect(await gaps()).toEqual([GAP]);
    connected = true;
    expect(await gaps()).toEqual([]);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('runs one check for the calls made while it runs', async () => {
    let finish = (_: readonly SetupGap[]): void => {};
    const check = vi.fn(
      () =>
        new Promise<readonly SetupGap[]>((resolve) => {
          finish = resolve;
        }),
    );
    const gaps = cachedSetupGaps({ check, now: () => 0, logger: { warn: vi.fn() } });

    const both = Promise.all([gaps(), gaps()]);
    finish([GAP]);

    expect(await both).toEqual([[GAP], [GAP]]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('gives up a check that takes too long: setup counts as complete and it is logged', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const gaps = cachedSetupGaps({
      check: () => new Promise<readonly SetupGap[]>(() => {}),
      now: () => 0,
      logger: { warn },
    });

    const answer = gaps();
    await vi.advanceTimersByTimeAsync(SETUP_CHECK_TIMEOUT_MS);

    expect(await answer).toEqual([]);
    expect(warn).toHaveBeenCalledWith('Could not check the setup in time', {
      timeoutMs: SETUP_CHECK_TIMEOUT_MS,
    });
  });
});
