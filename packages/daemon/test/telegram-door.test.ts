import type { DoorReply } from '@anomander/protocol';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnNotStartedError } from '../src/app/turns.ts';
import { openTelegramDoor, type TelegramDoor } from '../src/telegram-door.ts';

// B84: the door's crash halt marks the bot halted in the same tick it is called, so a refusal the
// daemon's turns give in that tick, before or after it, never reaches the bot first.
const PRINCIPAL = 4242;
const S22 =
  'Algo ha fallado y no he podido procesar tu mensaje. ¿Me lo vuelves a enviar en un rato?';

let api: FakeTelegramApi;
let door: TelegramDoor | undefined;
/** What settles every handler a test left waiting, so the stop at teardown never hangs. */
let releases: (() => void)[] = [];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

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

/** Opens the door with a text handler held until the test settles it. */
const doorWithHeldText = async () => {
  let refuse = (_error: Error): void => {};
  let answer = (_reply: DoorReply): void => {};
  const onText = vi.fn(
    () =>
      new Promise<DoorReply | null>((resolveText, rejectText) => {
        refuse = rejectText;
        answer = resolveText;
      }),
  );
  releases.push(() => answer({ text: 'tarde' }));
  door = openTelegramDoor(
    { botToken: api.token, principalChatId: PRINCIPAL },
    { onText, onReceipt: vi.fn(), onButton: vi.fn() },
    { logger, apiRoot: api.apiRoot },
  );
  await door.started;
  api.push(updates.text({ chatId: PRINCIPAL }, 'café 3'));
  await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));
  return { opened: door, refuse: (error: Error) => refuse(error) };
};

beforeEach(async () => {
  api = await startFakeTelegramApi();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(async () => {
  for (const release of releases) release();
  releases = [];
  await door?.stop();
  await door?.ended.catch(() => {});
  door = undefined;
  await api.close();
});

describe('the Telegram door halting (B84)', () => {
  it('a text refused in the tick the halt begins, just before it, is left for after the restart', async () => {
    const { opened, refuse } = await doorWithHeldText();

    refuse(new TurnNotStartedError());
    const halted = opened.halt();
    await halted;
    await opened.ended;

    expect(api.sent.map(({ text }) => text)).not.toContain(S22);
    expect(await unacknowledged()).toEqual(['café 3']);
  });

  it('a stop still answers a refused text with S-22 and acknowledges it', async () => {
    const { opened, refuse } = await doorWithHeldText();

    refuse(new TurnNotStartedError());
    await opened.stop();
    await opened.ended;

    await vi.waitFor(() => expect(api.sent.map(({ text }) => text)).toContain(S22));
    expect(await unacknowledged()).toEqual([]);
  });
});
