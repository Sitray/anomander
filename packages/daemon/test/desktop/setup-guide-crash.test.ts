import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitCodes } from '@anomander/protocol';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSetupGuide } from '../../src/app/setup-guide-mode.ts';
import type { Anomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { exitOnceWritten } from '../../src/crash.ts';
import { resolveModels, setupGuide } from '../../src/setup/setup-guide.ts';

// B85: a crash halts the setup guide's bot as it halts the daemon's (B82, B84): at once, with
// `haltTelegramBot`, not `bot.stop()`. The update it is handling is acknowledged once handled;
// one read after the halt gets no reply and is not acknowledged, so Telegram hands it over again
// once the daemon is back, and it is answered once.
const PRINCIPAL = 4242;
const pause = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

let scratch: string;
let api: FakeTelegramApi;
let proxy: Server | undefined;
let guide: Anomander | undefined;
/** Lets the guide's held reply go, so the stop at teardown never waits for it. */
let release = (): void => {};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const configFor = () =>
  loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_AUTH_PATH: join(scratch, 'auth.json'),
    TZ: 'Europe/Madrid',
  });

/** What Telegram still holds unacknowledged: offset 0 acknowledges nothing. */
const unacknowledged = async (): Promise<string[]> => {
  const response = await fetch(`${api.apiRoot}/bot${api.token}/getUpdates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset: 0, timeout: 0 }),
  });
  const body = (await response.json()) as { result: { message?: { text?: string } }[] };
  return body.result.map((update) => update.message?.text ?? '?');
};

/**
 * A Bot API in front of the fake one. Once `hold()` is called it keeps the next `sendMessage` back
 * until `release()`, and tells `seen` of it and of every `getUpdates` that acknowledges (an
 * offset above 0, outside a long poll).
 */
const holdingApi = async (seen: string[]) => {
  let holding = false;
  let held: Promise<void> | undefined;
  proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const payload = (body.startsWith('{') ? JSON.parse(body) : {}) as Record<string, unknown>;
    if (req.url?.endsWith('/sendMessage') === true && holding) {
      holding = false;
      held = new Promise<void>((resolveHeld) => {
        release = () => resolveHeld();
      });
      seen.push('reply held');
      await held;
      seen.push('reply sent');
    }
    if (req.url?.endsWith('/getUpdates') === true && payload.timeout === undefined) {
      seen.push(`acknowledged ${String(payload.offset ?? 0)}`);
    }
    const answer = await fetch(`${api.apiRoot}${req.url}`, {
      method: req.method ?? 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      ...(req.method === 'GET' ? {} : { body }),
    }).catch(() => undefined);
    if (answer === undefined) {
      res.destroy();
      return;
    }
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(await answer.text());
  });
  await new Promise<void>((listening) => proxy?.listen(0, '127.0.0.1', () => listening()));
  const { port } = proxy.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    hold: () => {
      holding = true;
    },
  };
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-setup-guide-crash-'));
  api = await startFakeTelegramApi();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(async () => {
  release();
  await guide?.stop();
  guide = undefined;
  await new Promise<void>((closed) =>
    proxy === undefined ? closed() : proxy.close(() => closed()),
  );
  proxy?.closeAllConnections();
  proxy = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the setup guide when the daemon crashes (B85)', () => {
  it('halts its bot at once: what it read after the halt gets no reply and comes again', async () => {
    const seen: string[] = [];
    const { apiRoot, hold } = await holdingApi(seen);
    const config = configFor();
    const resolved = resolveModels(config, () => undefined);
    if (resolved.ready) throw new Error('expected model gaps');
    const started = startSetupGuide(config, {
      gaps: resolved.gaps,
      telegramApiRoot: apiRoot,
      logger,
    });
    guide = started;
    await started.started;
    const text = setupGuide(resolved.gaps);
    // The guide it sends once the bot listens (R-28 AC3).
    await api.waitForSent(1);
    hold();
    // One `getUpdates` reads both: the bot answers the first, the second waits behind it.
    api.push(updates.text({ chatId: PRINCIPAL }, 'hola'));
    api.push(updates.text({ chatId: PRINCIPAL }, 'café 3'));
    await vi.waitFor(() => expect(seen).toContain('reply held'));

    const exited = new Promise<number>((resolveExit) => {
      const exit = exitOnceWritten(
        [],
        (code) => {
          seen.push(`exit ${code}`);
          resolveExit(code);
        },
        5_000,
        () => started.halt(),
      );
      exit(exitCodes.failed);
      release();
    });

    expect(await exited).toBe(exitCodes.failed);
    // Whatever the bot would still have done after the exit has had time to show.
    await pause(200);
    expect(seen.filter((step) => step !== 'reply held')).toEqual([
      'reply sent',
      expect.stringMatching(/^acknowledged [1-9]\d*$/),
      `exit ${exitCodes.failed}`,
    ]);
    expect(api.sent.map((sent) => sent.text)).toEqual([text, text]);
    expect(await unacknowledged()).toEqual(['café 3']);
  });

  it('a stop still answers what it read and acknowledges it, as before', async () => {
    const config = configFor();
    const resolved = resolveModels(config, () => undefined);
    if (resolved.ready) throw new Error('expected model gaps');
    const started = startSetupGuide(config, {
      gaps: resolved.gaps,
      telegramApiRoot: api.apiRoot,
      logger,
    });
    await started.started;
    await api.waitForSent(1);
    api.push(updates.text({ chatId: PRINCIPAL }, 'hola'));
    await api.waitForSent(2);

    await started.stop();

    expect(await unacknowledged()).toEqual([]);
  });
});
