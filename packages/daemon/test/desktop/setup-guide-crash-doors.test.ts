import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitCodes } from '@anomander/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B85: the setup guide's doors, each a stand-in, as its halt and its stop close them: a crash
// begins both in the same call and halts the bot; a stop keeps `bot.stop()`, waits for both
// doors, releases the lock and only then throws what failed. Its own file: it mocks the doors.
const doors = vi.hoisted(() => ({
  calls: [] as string[],
  localStop: (): Promise<void> => Promise.resolve(),
  tgStop: (): Promise<void> => Promise.resolve(),
  tgHalt: (): Promise<void> => Promise.resolve(),
}));

vi.mock('../../src/app/local-channel.ts', () => ({
  startChannel: () => ({
    listening: Promise.resolve({ host: '127.0.0.1', port: 1 }),
    loginWaiting: () => {},
    stop: () => {
      doors.calls.push('local.stop');
      return doors.localStop();
    },
  }),
}));
vi.mock('../../src/telegram-door.ts', () => ({
  openTelegramDoor: () => ({
    started: Promise.resolve(),
    ended: new Promise(() => {}),
    send: async () => {},
    deleteMessage: async () => {},
    stop: () => {
      doors.calls.push('telegram.stop');
      return doors.tgStop();
    },
    halt: () => {
      doors.calls.push('telegram.halt');
      return doors.tgHalt();
    },
  }),
}));

const { startSetupGuide } = await import('../../src/app/setup-guide-mode.ts');
const { loadConfig } = await import('../../src/config.ts');
const { resolveModels } = await import('../../src/setup/setup-guide.ts');
const { acquireDaemonLock } = await import('../../src/store/daemon-lock.ts');
const { exitOnceWritten } = await import('../../src/crash.ts');
const { SHUTDOWN_DEADLINE_MS } = await import('../../src/app/shutdown.ts');

let scratch: string;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const start = () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    ANOMANDER_PRINCIPAL_CHAT_ID: '4242',
    ANOMANDER_LOCAL_TOKEN: 'local-token-0123456789abcdef-0123456789',
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_AUTH_PATH: join(scratch, 'auth.json'),
    TZ: 'Europe/Madrid',
  });
  const resolved = resolveModels(config, () => undefined);
  if (resolved.ready) throw new Error('expected gaps');
  return { guide: startSetupGuide(config, { gaps: resolved.gaps, logger }), config };
};
const lockFree = (dbPath: string) => {
  try {
    acquireDaemonLock(dbPath).release();
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-setup-guide-doors-'));
  doors.calls = [];
  doors.localStop = () => Promise.resolve();
  doors.tgStop = () => Promise.resolve();
  doors.tgHalt = () => Promise.resolve();
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('the doors of the setup guide (B85)', () => {
  it('halt: both doors in the same call, telegram.halt (not stop)', async () => {
    const { guide, config } = start();
    await guide.halt();
    expect(doors.calls).toEqual(['local.stop', 'telegram.halt']);
    // halt does not release the lock (the exit does)
    expect(lockFree(config.dbPath)).toBe(false);
  });

  it('halt never rejects when a door rejects', async () => {
    doors.localStop = () => Promise.reject(new Error('local boom'));
    doors.tgHalt = () => Promise.reject(new Error('tg boom'));
    const { guide } = start();
    await expect(guide.halt()).resolves.toBeUndefined();
  });

  it('halt never rejects when a door throws at once, and closes each door only once', async () => {
    doors.localStop = () => {
      throw new Error('local thrown');
    };
    const { guide } = start();
    await expect(guide.halt()).resolves.toBeUndefined();
    await expect(guide.halt()).resolves.toBeUndefined();
    expect(doors.calls).toEqual(['local.stop', 'telegram.halt']);
  });

  it('stop: a failing local door still stops telegram, waits for it, releases the lock, throws first failure', async () => {
    let tgDone = false;
    let letTgGo = (): void => {};
    doors.localStop = () => Promise.reject(new Error('local boom'));
    doors.tgStop = () =>
      new Promise<void>((resolve) => {
        letTgGo = () => {
          tgDone = true;
          resolve();
        };
      });
    const { guide, config } = start();
    const stopping = guide.stop();
    let settled = false;
    stopping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(lockFree(config.dbPath)).toBe(false);
    expect(doors.calls).toEqual(['local.stop', 'telegram.stop']);
    letTgGo();
    await expect(stopping).rejects.toThrow('local boom');
    expect(tgDone).toBe(true);
    expect(lockFree(config.dbPath)).toBe(true);
  });

  it('B86: stop gives up on a hanging door at the deadline, logs it, releases the lock, throws the first failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      doors.localStop = () => Promise.reject(new Error('local boom'));
      doors.tgStop = () => new Promise(() => {});
      logger.warn.mockClear();
      const { guide, config } = start();
      const stopping = guide.stop();
      let settled = false;
      stopping.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      expect(lockFree(config.dbPath)).toBe(false);
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('ms passed'));
      await vi.advanceTimersByTimeAsync(1);
      await expect(stopping).rejects.toThrow('local boom');
      expect(lockFree(config.dbPath)).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        `the setup guide stopped before every door closed: ${SHUTDOWN_DEADLINE_MS} ms passed`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a crash during a stop reuses the stop (telegram.stop once, no halt)', async () => {
    let letGo = (): void => {};
    doors.tgStop = () => new Promise<void>((r) => (letGo = r));
    const { guide } = start();
    const stopping = guide.stop();
    const halting = guide.halt();
    letGo();
    await halting;
    await stopping;
    expect(doors.calls).toEqual(['local.stop', 'telegram.stop']);
  });

  it('a hanging telegram.halt: the crash exit still happens at the 5 s limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      doors.tgHalt = () => new Promise(() => {});
      const { guide } = start();
      const exited = vi.fn();
      exitOnceWritten([], exited, 5_000, () => guide.halt())(exitCodes.failed);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(exited).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exited).toHaveBeenCalledWith(exitCodes.failed);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Verifier probes (B86 item 5): the setup guide's stop past its deadline.
describe('the setup guide stop past its deadline (B86, verifier)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    logger.warn.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('both doors close in time: resolves at once, no warning, lock free', async () => {
    const { guide, config } = start();
    await expect(guide.stop()).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('ms passed'));
    expect(lockFree(config.dbPath)).toBe(true);
  });

  it('a door that rejects after the deadline: the stop resolved, the late rejection is handled', async () => {
    let fail = (_: Error): void => {};
    doors.tgStop = () => new Promise<void>((_, reject) => (fail = reject));
    const { guide, config } = start();
    const stopping = guide.stop();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    await expect(stopping).resolves.toBeUndefined();
    expect(lockFree(config.dbPath)).toBe(true);
    fail(new Error('late boom'));
    await vi.advanceTimersByTimeAsync(10);
    expect(
      logger.warn.mock.calls.filter(([line]) => String(line).includes('ms passed')),
    ).toHaveLength(1);
  });

  it('a door that closes after the deadline does not touch the lock a new daemon took', async () => {
    let done = (): void => {};
    doors.tgStop = () => new Promise<void>((resolve) => (done = resolve));
    const { guide, config } = start();
    const stopping = guide.stop();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    await stopping;
    const next = acquireDaemonLock(config.dbPath);
    done();
    await vi.advanceTimersByTimeAsync(10);
    expect(lockFree(config.dbPath)).toBe(false);
    next.release();
    expect(lockFree(config.dbPath)).toBe(true);
  });

  it('two stops racing on a hanging door: both end at the deadline, each door closed once', async () => {
    doors.tgStop = () => new Promise(() => {});
    const { guide, config } = start();
    const first = guide.stop();
    const second = guide.stop();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(doors.calls).toEqual(['local.stop', 'telegram.stop']);
    expect(lockFree(config.dbPath)).toBe(true);
  });

  it('a crash after a timed-out stop reuses the closing doors and still exits on time', async () => {
    doors.tgStop = () => new Promise(() => {});
    const { guide } = start();
    const stopping = guide.stop();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    await stopping;
    const exited = vi.fn();
    exitOnceWritten([], exited, 5_000, () => guide.halt())(exitCodes.failed);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exited).toHaveBeenCalledWith(exitCodes.failed);
    expect(doors.calls).toEqual(['local.stop', 'telegram.stop']);
  });

  it("both doors fail in time: the first door's failure is thrown, whichever failed first", async () => {
    doors.tgStop = () => Promise.reject(new Error('tg boom'));
    doors.localStop = () =>
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('local boom')), 100));
    const { guide } = start();
    const stopping = guide.stop();
    stopping.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopping).rejects.toThrow('local boom');
  });

  it('a door fails in time, the other hangs: that failure is thrown at the deadline', async () => {
    doors.tgStop = () => Promise.reject(new Error('tg boom'));
    doors.localStop = () => new Promise(() => {});
    const { guide, config } = start();
    const stopping = guide.stop();
    stopping.catch(() => {});
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    await expect(stopping).rejects.toThrow('tg boom');
    expect(lockFree(config.dbPath)).toBe(true);
  });
});
