import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitCodes, LOCAL_CHANNEL_PROTOCOL } from '@anomander/protocol';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { exitOnceWritten } from '../../src/crash.ts';
import { type SetupGap, setupGuide } from '../../src/setup/setup-guide.ts';

// B82: a Telegram text that waits for its turn behind the app's turn when the daemon halts. A
// crash leaves it unacknowledged and unanswered, so Telegram hands it over again after the
// restart; a stop answers it with S-22 and acknowledges it, as before.
const TOKEN = 'telegram-halt-token-0123456789abcdef';
const PRINCIPAL = 4242;
const S22 =
  'Algo ha fallado y no he podido procesar tu mensaje. ¿Me lo vuelves a enviar en un rato?';

let scratch: string;
let api: FakeTelegramApi;
let daemon: Anomander | undefined;
let sockets: WebSocket[] = [];
/** What settles the model call a test left waiting, so the stop at teardown never hangs. */
let releases: (() => void)[] = [];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const pause = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const configFor = () => ({
  ...loadConfig({
    ANOMANDER_LOCAL_TOKEN: TOKEN,
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
    TZ: 'Europe/Madrid',
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
  }),
  localPort: 0,
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
 * Starts the daemon with a model call that waits until released, then holds the chat's turn with
 * a text from the app and pushes a Telegram text, which waits for its turn behind it.
 */
const telegramTextBehindAppTurn = async () => {
  let release = (): void => {};
  const answered = new Promise<never>((_, reject) => {
    release = () => reject(new Error('the model call is over'));
  });
  answered.catch(() => {});
  releases.push(release);
  const complete = vi.fn(async (): Promise<never> => answered);
  const started = startAnomander(configFor(), {
    complete,
    model: 'openai/gpt-4o-mini',
    telegramApiRoot: api.apiRoot,
    logger,
    shutdownDeadlineMs: 50,
  });
  daemon = started;
  await started.started;
  const address = await started.localChannel;
  if (address === undefined) throw new Error('no local channel');
  const socket = new WebSocket(`ws://${address.host}:${address.port}`, [
    LOCAL_CHANNEL_PROTOCOL,
    TOKEN,
  ]);
  sockets.push(socket);
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener('open', () => resolveOpen());
    socket.addEventListener('error', () => reject(new Error('the app could not connect')));
  });
  socket.send(JSON.stringify({ type: 'text', text: 'hola desde la app', id: 'r1' }));
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  api.push(updates.text({ chatId: PRINCIPAL }, 'café 3'));
  await pause(300);
  return { started, release };
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-telegram-halt-'));
  api = await startFakeTelegramApi();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(async () => {
  for (const release of releases) release();
  releases = [];
  for (const socket of sockets) socket.close();
  sockets = [];
  await daemon?.stop();
  daemon = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('a Telegram text waiting behind the app turn when the daemon halts (B82)', () => {
  it('a crash leaves it unacknowledged and unanswered', async () => {
    const { started } = await telegramTextBehindAppTurn();

    started.halt();
    await started.polling.catch(() => {});
    await pause(200);

    expect(await unacknowledged()).toEqual(['café 3']);
    expect(api.sent.map(({ text }) => text)).not.toContain(S22);
  });

  it('a stop answers it with S-22 and acknowledges it, and the store closes after the turns', async () => {
    const { started, release } = await telegramTextBehindAppTurn();
    daemon = undefined;

    const stopped = started.stop();
    await pause(200);
    release();
    await stopped;

    expect(api.sent.map(({ text }) => text)).toContain(S22);
    expect(await unacknowledged()).toEqual([]);
    expect(
      logger.error.mock.calls.filter(([, fields]) => /not open/.test(String(fields?.error))),
    ).toEqual([]);
  });
});

// B84: a Telegram text still in its setup check (`setupGaps`, up to 5 s) when the daemon halts
// is not yet waiting for its turn. Closing the turns refuses it at once all the same, so a crash
// leaves it for after the restart, and the check, shared with the startup's, runs once.
describe('a Telegram text in its setup check when the daemon halts (B84)', () => {
  /** Starts the daemon with a setup check that waits until released, then pushes a text. */
  const telegramTextInSetupCheck = async () => {
    let answerCheck = (_gaps: readonly SetupGap[]): void => {};
    const check = vi.fn(
      () =>
        new Promise<readonly SetupGap[]>((resolveCheck) => {
          answerCheck = resolveCheck;
        }),
    );
    releases.push(() => answerCheck([]));
    const complete = vi.fn(async () => {
      throw new Error('no model call is expected');
    });
    const started = startAnomander(configFor(), {
      complete,
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      shutdownDeadlineMs: 50,
      setupGaps: check,
    });
    daemon = started;
    await started.started;
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    api.push(updates.text({ chatId: PRINCIPAL }, 'café 3'));
    await pause(300);
    return { started, check, complete };
  };

  it('a crash leaves it unacknowledged and unanswered, its setup check run once', async () => {
    const { started, check, complete } = await telegramTextInSetupCheck();

    started.halt();
    await started.polling.catch(() => {});
    await pause(200);

    expect(await unacknowledged()).toEqual(['café 3']);
    expect(api.sent.map(({ text }) => text)).not.toContain(S22);
    expect(check).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('a crash exit leaves it unacknowledged and exits only once the halt settled', async () => {
    const { started, check } = await telegramTextInSetupCheck();
    const order: string[] = [];
    const exited = new Promise<number>((resolveExit) => {
      const exit = exitOnceWritten(
        [],
        (code) => {
          order.push(`exit ${code}`);
          resolveExit(code);
        },
        5_000,
        () =>
          started.halt().then(() => {
            order.push('halted');
          }),
      );
      exit(exitCodes.failed);
    });

    expect(await exited).toBe(exitCodes.failed);
    expect(order).toEqual(['halted', `exit ${exitCodes.failed}`]);
    expect(await unacknowledged()).toEqual(['café 3']);
    expect(api.sent.map(({ text }) => text)).not.toContain(S22);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a stop answers it with S-22 at once and acknowledges it, as a stop answers a waiting turn', async () => {
    const { started, check } = await telegramTextInSetupCheck();
    daemon = undefined;

    await started.stop();

    await vi.waitFor(() => expect(api.sent.map(({ text }) => text)).toContain(S22));
    expect(await unacknowledged()).toEqual([]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a normal turn still gets the setup guide while a gap is open (R-28 AC4)', async () => {
    const gaps: SetupGap[] = [{ kind: 'provider_unconnected', providerId: 'openai' }];
    const complete = vi.fn(async () => {
      throw new Error('no model call is expected');
    });
    const started = startAnomander(configFor(), {
      complete,
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      shutdownDeadlineMs: 50,
      setupGaps: async () => gaps,
    });
    daemon = started;
    await started.started;
    const guides = () => api.sent.filter(({ text }) => text === setupGuide(gaps)).length;
    // The startup's announcement first, then the text's own answer.
    await vi.waitFor(() => expect(guides()).toBe(1));
    api.push(updates.text({ chatId: PRINCIPAL }, 'café 3'));

    await vi.waitFor(() => expect(guides()).toBe(2));
    expect(api.sent.map(({ text }) => text)).not.toContain(S22);
    expect(complete).not.toHaveBeenCalled();
  });
});

// B84: a crash exits once its log is out and its halt settled, the bot's last `getUpdates`
// included, so Telegram learns what was handled before the process is gone.
describe('a crash exit and the halt of the bot (B84)', () => {
  let proxy: Server | undefined;
  afterEach(async () => {
    // The daemon stops through the proxy, so the proxy closes after it.
    for (const release of releases) release();
    releases = [];
    await daemon?.stop();
    daemon = undefined;
    await new Promise<void>((closed) =>
      proxy === undefined ? closed() : proxy.close(() => closed()),
    );
    proxy = undefined;
  });

  /** A Bot API in front of the fake one that tells `seen` of every `getUpdates` and its offset. */
  const recordingApi = async (seen: string[]): Promise<string> => {
    proxy = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();
      if (req.url?.endsWith('/getUpdates') === true) {
        const { offset } = (body === '' ? {} : JSON.parse(body)) as { offset?: number };
        seen.push(`getUpdates ${offset ?? 0}`);
      }
      const answer = await fetch(`${api.apiRoot}${req.url}`, {
        method: req.method ?? 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        ...(req.method === 'GET' ? {} : { body }),
      });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(await answer.text());
    });
    await new Promise<void>((listening) => proxy?.listen(0, '127.0.0.1', () => listening()));
    const { port } = proxy.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  it('waits for the acknowledgement of a turn that runs, sent after the log is out, then exits', async () => {
    const seen: string[] = [];
    const apiRoot = await recordingApi(seen);
    let release = (): void => {};
    const answered = new Promise<never>((_, reject) => {
      release = () => reject(new Error('the model call is over'));
    });
    answered.catch(() => {});
    releases.push(release);
    const complete = vi.fn(async (): Promise<never> => answered);
    const started = startAnomander(configFor(), {
      complete,
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: apiRoot,
      logger,
      shutdownDeadlineMs: 50,
    });
    daemon = started;
    await started.started;
    api.push(updates.text({ chatId: PRINCIPAL }, 'café 3'));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    // The log is out at once; the halt waits for the running turn before it acknowledges it.
    const drained = {
      write: (_chunk: string, done: () => void) => {
        setImmediate(done);
        return true;
      },
    };
    const exited = new Promise<number>((resolveExit) => {
      const exit = exitOnceWritten(
        [drained],
        (code) => {
          seen.push(`exit ${code}`);
          resolveExit(code);
        },
        5_000,
        () => started.halt(),
      );
      seen.length = 0;
      exit(exitCodes.failed);
    });

    expect(await exited).toBe(exitCodes.failed);
    expect(seen).toEqual([
      expect.stringMatching(/^getUpdates [1-9]\d*$/),
      `exit ${exitCodes.failed}`,
    ]);
    expect(await unacknowledged()).toEqual([]);
  });
});

// B84: what the daemon's halt settles on: the bot's acknowledgement, not the turns that run.
describe('what the daemon halt waits for (B84)', () => {
  it('with a Telegram turn running it settles after the acknowledgement, not the turn; a text read meanwhile comes again', async () => {
    let release = (): void => {};
    const answered = new Promise<never>((_, reject) => {
      release = () => reject(new Error('the model call is over'));
    });
    answered.catch(() => {});
    releases.push(release);
    const complete = vi.fn(async (): Promise<never> => answered);
    const started = startAnomander(configFor(), {
      complete,
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      shutdownDeadlineMs: 50,
    });
    daemon = started;
    await started.started;
    api.push(updates.text({ chatId: PRINCIPAL }, 'café 3'));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    api.push(updates.text({ chatId: PRINCIPAL }, 'té 2'));
    await pause(100);
    const began = Date.now();

    const result = await started.halt();
    const took = Date.now() - began;

    expect(result).toBeUndefined();
    expect(took).toBeGreaterThanOrEqual(240);
    expect(took).toBeLessThan(2000);
    expect(await unacknowledged()).toEqual(['té 2']);
    expect(complete).toHaveBeenCalledTimes(1);
    // A second halt settles at once with the same outcome.
    await expect(started.halt()).resolves.toBeUndefined();
  });

  it('before any update it settles without waiting the limit', async () => {
    const started = startAnomander(configFor(), {
      complete: vi.fn(async () => {
        throw new Error('no model call is expected');
      }),
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      shutdownDeadlineMs: 50,
    });
    daemon = started;
    await started.started;
    const began = Date.now();

    await started.halt();

    expect(Date.now() - began).toBeLessThan(240);
  });
});
