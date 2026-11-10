import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { stopsWithParent, stopWhenParentGoes } from '../../src/supervised.ts';

// DK-1 AC1 (docs/desktop-prd.md): the daemon stops when the app that started it is gone.
describe('a supervised daemon', () => {
  it('stops with its parent only when asked to', () => {
    expect(stopsWithParent({ ANOMANDER_STOP_WITH_PARENT: '1' })).toBe(true);
    expect(stopsWithParent({})).toBe(false);
    expect(stopsWithParent({ ANOMANDER_STOP_WITH_PARENT: 'true' })).toBe(false);
  });

  it('DK-1 AC1: stops once when stdin ends, and ignores what arrives on it', async () => {
    const stdin = new PassThrough();
    const stop = vi.fn();
    stopWhenParentGoes(stdin, stop);

    stdin.write('ignored');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).not.toHaveBeenCalled();

    stdin.end();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    stdin.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('DK-1 AC1: stops when stdin is closed without an end, as when the parent is killed', async () => {
    const stdin = new PassThrough();
    const stop = vi.fn();
    stopWhenParentGoes(stdin, stop);

    stdin.destroy();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });
});
