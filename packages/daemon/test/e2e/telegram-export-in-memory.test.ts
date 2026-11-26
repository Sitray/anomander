import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';

// B52: with `ANOMANDER_DB_PATH=:memory:` there is no data folder, so `/exportar` writes nothing,
// least of all an `exports` folder in the folder the daemon was started from, and replies S-80.
const PRINCIPAL = 4242;
const NOW = new Date('2026-11-24T10:30:00.000Z');

let scratch: string;
let startedIn: string;
let api: FakeTelegramApi;
let anomander: Anomander;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-export-memory-'));
  // The daemon is started from `scratch`: whatever lands in "the current folder" lands there. The
  // change of folder stays: the daemon lock of an in-memory store is `:memory:.lock` in the current
  // folder (a known follow-up), which would otherwise land in the repository. Vitest runs test files
  // in child processes (`forks`), where `process.chdir` works and is undone in `afterEach`.
  startedIn = process.cwd();
  process.chdir(scratch);
  api = await startFakeTelegramApi();
  logger = { info: vi.fn<Log>(), warn: vi.fn<Log>(), error: vi.fn<Log>() };
  anomander = startAnomander(
    loadConfig({
      TELEGRAM_BOT_TOKEN: api.token,
      ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
      ANOMANDER_DB_PATH: ':memory:',
      ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
      ANOMANDER_MODEL: 'openai/gpt-4o-mini',
      ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
    }),
    {
      complete: async () => {
        throw new Error('the processor must not be called');
      },
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      now: () => NOW,
    },
  );
  await anomander.started;
});

afterEach(async () => {
  await anomander.stop();
  await api.close();
  process.chdir(startedIn);
  rmSync(scratch, { recursive: true, force: true });
});

describe('/exportar with an in-memory store (B52)', () => {
  it('replies S-80 and writes no exports folder in the current folder', async () => {
    api.push(updates.text({ chatId: PRINCIPAL }, '/exportar'));

    const [reply] = await api.waitForSent(1);
    expect(reply?.text).toBe('No he podido exportar tus datos. Inténtalo de nuevo en un rato.');
    expect(api.documents).toEqual([]);
    expect(readdirSync(scratch)).not.toContain('exports');
    expect(logger.error).toHaveBeenCalledWith('the ledger export failed', {
      reason: 'InMemoryStoreError',
    });
  });
});
