import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_CHANNEL_PROTOCOL } from '@anomander/protocol';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';

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
