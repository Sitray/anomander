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
