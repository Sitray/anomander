import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ChatEvent,
  type ChatReply,
  type ChatRequest,
  HISTORY_LIMIT,
  LOCAL_CHANNEL_PROTOCOL,
  strings,
  WEB_SEARCH_CONNECTION,
} from '@anomander/protocol';
import {
  type FakeTelegramApi,
  pngBytes,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import type { AssistantMessage, Context, Credential } from '@earendil-works/pi-ai';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  type Anomander,
  type AnomanderDeps,
  startAnomander,
  startSetupGuide,
} from '../../src/app.ts';
import { createFileCredentialStore } from '../../src/auth/file-credential-store.ts';
import type { ModelLogin } from '../../src/auth/telegram-login.ts';
import { loadConfig } from '../../src/config.ts';
import type { Connection } from '../../src/connections/connection.ts';
import { connectionTaskPrompt } from '../../src/connections/task.ts';
import { computerPlannerPrompt } from '../../src/processor/computer-planner.ts';
import { RECEIPT_READER_PROMPT } from '../../src/processor/receipt-reader.ts';
import { replyPhraserPrompt } from '../../src/processor/reply-phraser.ts';
import { screenReaderPrompt } from '../../src/processor/screen-reader.ts';
import { textInterpreterPrompt } from '../../src/processor/text-interpreter.ts';
import { recordMessages } from '../../src/store/conversation.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import { saveMemory } from '../../src/store/memory.ts';

// DK-3 and DK-4 (docs/desktop-prd.md): a real WebSocket client, as the desktop app's window is,
// against the local channel of a started daemon, with the fake Telegram API, a SQLite file and
// recorded processor responses, as in `test/e2e/`.
const PRINCIPAL = 4242;
const TOKEN = 'local-channel-test-token-0123456789abcdef';
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const recorded = (path: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${path}.json`), 'utf8'));
const PHRASED = '¡Hecho! He apuntado 23,00 € de la cena en restaurantes.';
const S19 = 'Esa pregunta ya no está abierta.';
const SEEN = 'Tienes abierto un correo de Marta sobre la cena del viernes.';
const CLICK = { kind: 'click', x: 512, y: 80, double: false, target: 'Enviar' };
const NOT_SEEN = 'No he podido ver tu pantalla. ¿Me lo vuelves a pedir en un rato?';

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander | undefined;
let sockets: WebSocket[];
/** The user turns the text interpreter received, parsed. */
let interpreted: {
  recent: unknown;
  message: string;
  routes: unknown;
  history: unknown;
  connected: unknown;
}[];
/** What the text interpreter answers instead of an expense, as its JSON text (DK-13). */
let routed: string | undefined;
/** What the text interpreter waits for before it answers. */
let interpreting: Promise<void>;
/** The contexts the computer planner received. */
let plans: Context[];
/** What the computer planner answers, as the text of its response. */
let planned: () => Promise<string>;
/** The contexts the screen reader received. */
let screens: Context[];
/** What the screen reader answers; a test replaces it to make the call fail. */
let seen: () => Promise<string>;
/** The servers a task with connections finds connected. */
let connected: Connection[];
/** What the code knows about the servers that are not. */
let problems: { invalid: boolean; unreachable: string[] };
/** What the processor answers to a task with connections, one response per call. */
let tooled: AssistantMessage['content'][];
/** What the processor of a task with connections waits for before each answer. */
let held: Promise<void>;
/** The contexts the processor of a task with connections received, copied. */
let tasked: Context[];
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };

const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
  if (context.systemPrompt === RECEIPT_READER_PROMPT) {
    return recorded('receipt-reader/lines-mismatch');
  }
  const reply = recorded('text-interpreter/expense-23-space-euro');
  if (context.systemPrompt === computerPlannerPrompt()) {
    plans.push(context);
    return { ...reply, content: [{ type: 'text', text: await planned() }] };
  }
  if (context.systemPrompt === connectionTaskPrompt()) {
    tasked.push(structuredClone(context));
    await held;
    return { ...reply, content: tooled.shift() ?? [] };
  }
  if (context.systemPrompt === screenReaderPrompt()) {
    screens.push(context);
    return { ...reply, content: [{ type: 'text', text: await seen() }] };
  }
  if (context.systemPrompt === replyPhraserPrompt()) {
    return { ...reply, content: [{ type: 'text', text: PHRASED }] };
  }
  const [turn] = context.messages;
  if (typeof turn?.content === 'string') interpreted.push(JSON.parse(turn.content));
  await interpreting;
  return routed === undefined ? reply : { ...reply, content: [{ type: 'text', text: routed }] };
};

const config = (env: Record<string, string> = {}) =>
  loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
    ...env,
  });

/** Starts the daemon; the channel, when on, listens on a free port so tests never use 4312. */
const start = async (
  env: Record<string, string> = { ANOMANDER_LOCAL_TOKEN: TOKEN },
  deps: Partial<AnomanderDeps<string>> = {},
  /** Leaves the servers to `mcp.json` (`ANOMANDER_MCP_CONFIG`) instead of `connected`. */
  fromFile = false,
) => {
  anomander = startAnomander(
    { ...config(env), localPort: 0 },
    {
      complete,
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      ...(fromFile
        ? {}
        : { connections: async () => connected, connectionProblems: () => problems }),
      ...deps,
    },
  );
  await anomander.started;
  return anomander;
};

const channelUrl = async (daemon: Anomander): Promise<string> => {
  const address = await daemon.localChannel;
  if (address === undefined) throw new Error('the local channel did not start');
  return `ws://${address.host}:${address.port}`;
};

/** A connected client: `ask` sends a request and resolves with the event that answers it. */
const client = async (daemon: Anomander, token = TOKEN) => {
  const socket = new WebSocket(await channelUrl(daemon), [LOCAL_CHANNEL_PROTOCOL, token]);
  sockets.push(socket);
  const events: ChatEvent[] = [];
  const waiting = new Set<() => void>();
  socket.addEventListener('message', (message) => {
    events.push(JSON.parse(String(message.data)));
    for (const check of waiting) check();
  });
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener('open', () => resolveOpen());
    socket.addEventListener('close', () => reject(new Error('closed before it opened')));
  });
  let nextId = 1;
  const answerTo = (id: string | null) =>
    new Promise<ChatEvent>((resolveEvent) => {
      const check = () => {
        const event = events.find((candidate) => candidate.inReplyTo === id);
        if (event === undefined) return;
        waiting.delete(check);
        resolveEvent(event);
      };
      waiting.add(check);
      check();
    });
  return {
    events,
    protocol: () => socket.protocol,
    sendRaw: (frame: string) => {
      socket.send(frame);
    },
    answerTo,
    ask: (request: Record<string, unknown> & { type: ChatRequest['type'] }) => {
      const id = `m${nextId++}`;
      socket.send(JSON.stringify({ ...request, id }));
      return answerTo(id);
    },
  };
};

const reply = (event: ChatEvent): ChatReply => {
  if (event.type !== 'reply') throw new Error(`expected a reply, got ${JSON.stringify(event)}`);
  return event;
};

const png = () => ({ mimeType: 'image/png', data: Buffer.from(pngBytes(200)).toString('base64') });

const query = <T>(sql: string): T[] => {
  const db = new Database(join(scratch, 'anomander.db'), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

/**
 * What a raw TCP client gets back for `request`: every byte until the daemon closes, or the
 * first bytes when `untilData` is set.
 */
const rawExchange = async (
  daemon: Anomander,
  request: string,
  untilData = false,
): Promise<string> => {
  const address = await daemon.localChannel;
  if (address === undefined) throw new Error('the local channel did not start');
  return new Promise<string>((resolveBytes, reject) => {
    const socket = connect(address.port, address.host, () => socket.write(request));
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (untilData) socket.destroy();
    });
    socket.on('close', () => resolveBytes(received));
    socket.on('error', reject);
  });
};

const upgrade = (protocols: string | null) =>
  [
    'GET / HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...(protocols === null ? [] : [`Sec-WebSocket-Protocol: ${protocols}`]),
    '',
    '',
  ].join('\r\n');

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-local-'));
  api = await startFakeTelegramApi();
  sockets = [];
  interpreted = [];
  routed = undefined;
  interpreting = Promise.resolve();
  screens = [];
  plans = [];
  planned = async () => JSON.stringify(CLICK);
  seen = async () => SEEN;
  connected = [];
  problems = { invalid: false, unreachable: [] };
  tooled = [];
  held = Promise.resolve();
  tasked = [];
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(async () => {
  for (const socket of sockets) socket.close();
  await anomander?.stop();
  anomander = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the local channel', () => {
  it('is off while ANOMANDER_LOCAL_TOKEN is unset: no port opens', async () => {
    const daemon = await start({});
    expect(daemon.localChannel).toBeUndefined();
  });

  it('refuses a token shorter than 32 characters', () => {
    expect(() => config({ ANOMANDER_LOCAL_TOKEN: 'short' })).toThrow(
      'invalid configuration: ANOMANDER_LOCAL_TOKEN must have at least 32 characters',
    );
  });

  it('DK-3 AC1: listens on 127.0.0.1 and speaks the protocol of packages/protocol', async () => {
    const daemon = await start();
    expect((await daemon.localChannel)?.host).toBe('127.0.0.1');
    expect((await client(daemon)).protocol()).toBe(LOCAL_CHANNEL_PROTOCOL);
  });

  it('DK-3 AC2: a connection without the token is closed with no data', async () => {
    const daemon = await start();
    const wrong = `${TOKEN.slice(0, -1)}X`;
    expect(await rawExchange(daemon, upgrade(null))).toBe('');
    expect(await rawExchange(daemon, upgrade(LOCAL_CHANNEL_PROTOCOL))).toBe('');
    expect(await rawExchange(daemon, upgrade(`${LOCAL_CHANNEL_PROTOCOL}, ${wrong}`))).toBe('');
    expect(await rawExchange(daemon, upgrade(TOKEN))).toBe('');
    expect(await rawExchange(daemon, 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')).toBe('');
    // What Node's HTTP server would answer by itself: 400, 100 Continue and 431.
    expect(await rawExchange(daemon, 'hello there\r\n\r\n')).toBe('');
    expect(
      await rawExchange(
        daemon,
        'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: 100-continue\r\nContent-Length: 5\r\n\r\n',
      ),
    ).toBe('');
    expect(
      await rawExchange(daemon, `GET / HTTP/1.1\r\nX-Long: ${'a'.repeat(20000)}\r\n\r\n`),
    ).toBe('');
    await expect(client(daemon, wrong)).rejects.toThrow('closed before it opened');
    // The same request with the token is answered.
    expect(
      await rawExchange(daemon, upgrade(`${LOCAL_CHANNEL_PROTOCOL}, ${TOKEN}`), true),
    ).toContain('101 Switching Protocols');
  });

  it('DK-3 AC2: never logs the token', async () => {
    const daemon = await start();
    const chat = await client(daemon);
    await chat.ask({ type: 'text', text: '23 € cena' });
    await client(daemon, `${TOKEN}-wrong`).catch(() => {});
    const logged = JSON.stringify(
      [logger.info, logger.warn, logger.error].flatMap((log) => log.mock.calls),
    );
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain('local channel');
  });

  it('a frame that is not a request is rejected and nothing is done with it', async () => {
    const chat = await client(await start());
    chat.sendRaw('not json');
    expect(await chat.answerTo(null)).toEqual({ type: 'rejected', inReplyTo: null });
    chat.sendRaw(JSON.stringify({ type: 'text', id: 'x1' }));
    expect(await chat.answerTo('x1')).toEqual({ type: 'rejected', inReplyTo: 'x1' });
    // An image that is not base64 would cost a processor call for nothing.
    chat.sendRaw(
      JSON.stringify({
        type: 'receipt',
        id: 'x2',
        images: [{ mimeType: 'image/png', data: '!!!' }],
        caption: null,
      }),
    );
    expect(await chat.answerTo('x2')).toEqual({ type: 'rejected', inReplyTo: 'x2' });
    expect(interpreted).toEqual([]);
  });
});

describe('the chat over the local channel', () => {
  it('DK-4 AC1: "23 € cena" creates the same expense and the same reply as in Telegram', async () => {
    const chat = await client(await start());

    const answer = reply(await chat.ask({ type: 'text', text: '23 € cena' }));
    expect(answer).toMatchObject({ text: PHRASED, buttons: [] });
    expect(answer.channelRef).toMatch(/^desktop:[0-9a-f-]{36}$/);

    await vi.waitFor(() =>
      expect(query("SELECT status FROM actions WHERE status = 'verified'")).toHaveLength(1),
    );
    expect(query('SELECT total_cents, mode, document_id, category_basis FROM expenses')).toEqual([
      { total_cents: 2300, mode: 'declared', document_id: null, category_basis: 'inferred' },
    ]);
    // R-9 AC2: the delivery is observed on the channel the reply went through.
    expect(
      query(`SELECT a.source, a.value_json FROM actions x
             JOIN assertions a ON a.id = x.verification_assertion_id`),
    ).toEqual([{ source: answer.channelRef, value_json: JSON.stringify({ text: PHRASED }) }]);
    expect(api.sent).toEqual([]);
  });

  it('DK-4 AC1: /start gets the same S-69 as in Telegram', async () => {
    const chat = await client(await start());
    expect(reply(await chat.ask({ type: 'text', text: '/start' })).text).toBe('¡Hola!');
    expect(interpreted).toEqual([]);
  });

  it('R-29 AC4: /exportar in the app gets S-81 and exports nothing', async () => {
    const chat = await client(await start());
    expect(reply(await chat.ask({ type: 'text', text: '/exportar' }))).toMatchObject({
      text: 'De momento la exportación solo llega por Telegram: escribe /exportar allí.',
    });
    expect(interpreted).toEqual([]);
    expect(api.sent).toEqual([]);
    expect(existsSync(join(scratch, 'exports'))).toBe(false);
  });

  it('DK-4 AC2, AC3: a dropped image is a receipt; its question shows its buttons, and a decision answered in the app is closed in Telegram too (S-19)', async () => {
    const chat = await client(await start());

    const question = reply(await chat.ask({ type: 'receipt', images: [png()], caption: null }));
    expect(question.buttons.map((button) => button.label)).toEqual([
      'Apuntar',
      'Corregir',
      'Descartar',
    ]);
    expect(query('SELECT status FROM pending_decisions')).toEqual([{ status: 'open' }]);
    // R-17 AC2: the question's own reference is what the decision remembers.
    expect(query('SELECT channel_ref FROM pending_decisions')).toEqual([
      { channel_ref: question.channelRef },
    ]);

    const [apuntar, , descartar] = question.buttons as { label: string; data: string }[];
    await chat.ask({ type: 'button', data: apuntar?.data, channelRef: question.channelRef });
    expect(query('SELECT status FROM pending_decisions')).toEqual([{ status: 'answered' }]);
    expect(query('SELECT total_cents FROM expenses')).toHaveLength(1);

    // The same decision pressed in Telegram, and again in the app.
    api.push(updates.callbackQuery({ chatId: PRINCIPAL }, String(descartar?.data), 1));
    expect((await api.waitForSent(1)).at(-1)?.text).toBe(S19);
    expect(
      reply(
        await chat.ask({ type: 'button', data: descartar?.data, channelRef: question.channelRef }),
      ).text,
    ).toBe(S19);
    expect(query('SELECT total_cents FROM expenses')).toHaveLength(1);
  });

  it('DK-4 AC2: inputs R-20 does not support get the same replies as in Telegram', async () => {
    const chat = await client(await start());
    const sendFile = async (mimeType: string, data = 'AAAA') =>
      reply(await chat.ask({ type: 'receipt', images: [{ mimeType, data }], caption: null })).text;

    expect(await sendFile('application/pdf')).toBe(
      'Todavía no leo PDF. ¿Me mandas una foto del ticket?',
    );
    expect(await sendFile('video/mp4')).toBe('De momento solo entiendo texto y fotos de tickets.');
    expect(await sendFile('image/png', 'A'.repeat(28 * 1024 * 1024))).toBe(
      'La imagen es demasiado grande. ¿Me mandas una foto más ligera?',
    );
    expect(query('SELECT id FROM documents')).toEqual([]);
  });

  it('DK-4 AC4: turns from Telegram and from the app are the same recent context', async () => {
    const chat = await client(await start());

    api.push(updates.text({ chatId: PRINCIPAL }, '23 € cena'));
    await api.waitForSent(1);
    await chat.ask({ type: 'text', text: '23 € comida' });
    api.push(updates.text({ chatId: PRINCIPAL }, '23 € merienda'));
    await api.waitForSent(2);

    expect(interpreted.map(({ message, recent }) => ({ message, recent }))).toEqual([
      { message: '23 € cena', recent: [] },
      { message: '23 € comida', recent: [{ principal: '23 € cena', reply: PHRASED }] },
      {
        message: '23 € merienda',
        recent: [
          { principal: '23 € cena', reply: PHRASED },
          { principal: '23 € comida', reply: PHRASED },
        ],
      },
    ]);
  });

  it('DK-4 AC5: a message ANOMANDER sends unasked goes to Telegram only', async () => {
    const daemon = await start();
    const chat = await client(daemon);
    // R-12 AC2, AC3: a receipt over the cap is queued; S-10 goes out unasked, once.
    await daemon.stop();
    anomander = undefined;
    const capped = startAnomander(
      {
        ...config({ ANOMANDER_LOCAL_TOKEN: TOKEN, ANOMANDER_DAILY_AI_CALL_LIMIT: '0' }),
        localPort: 0,
      },
      { complete, model: 'openai/gpt-4o-mini', telegramApiRoot: api.apiRoot, logger },
    );
    anomander = capped;
    await capped.started;
    const second = await client(capped);

    api.push(updates.photo({ chatId: PRINCIPAL }));
    await api.waitForSent(1);
    expect(second.events).toEqual([]);
    expect(chat.events).toEqual([]);
  });

  it('answers with the setup guide while no model is usable (R-28)', async () => {
    const guide = startSetupGuide(
      { ...config({ ANOMANDER_LOCAL_TOKEN: TOKEN }), localPort: 0 },
      { gaps: [{ kind: 'model_unset' }], telegramApiRoot: api.apiRoot, logger },
    );
    anomander = guide;
    await guide.started;
    const chat = await client(guide);

    const sent = await api.waitForSent(1);
    expect(reply(await chat.ask({ type: 'text', text: 'hola' })).text).toBe(sent[0]?.text);
  });
});

// DK-16 (docs/desktop-prd.md): the conversation is kept in the local database, from both doors;
// the app asks for it when its chat is empty and can erase it.
describe('the stored conversation (DK-16)', () => {
  const history = async (chat: Awaited<ReturnType<typeof client>>, limit?: number) => {
    const event = await chat.ask({ type: 'history', ...(limit === undefined ? {} : { limit }) });
    if (event.type !== 'history') throw new Error(`expected history, got ${JSON.stringify(event)}`);
    return event.messages;
  };
  const AT = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);

  it('S2, S4: keeps the messages of both doors and answers history with them, oldest first', async () => {
    const chat = await client(await start());

    const answer = reply(await chat.ask({ type: 'text', text: '23 € cena' }));
    api.push(updates.text({ chatId: PRINCIPAL }, '23 € merienda'));
    const [sent] = await api.waitForSent(1);
    const question = reply(await chat.ask({ type: 'receipt', images: [png()], caption: 'cena' }));

    expect(await history(chat)).toEqual([
      {
        id: expect.any(Number),
        from: 'principal',
        door: 'app',
        text: '23 € cena',
        buttons: [],
        channelRef: null,
        at: AT,
      },
      {
        id: expect.any(Number),
        from: 'anomander',
        door: 'app',
        text: PHRASED,
        buttons: [],
        channelRef: answer.channelRef,
        at: AT,
      },
      {
        id: expect.any(Number),
        from: 'principal',
        door: 'telegram',
        text: '23 € merienda',
        buttons: [],
        channelRef: null,
        at: AT,
      },
      {
        id: expect.any(Number),
        from: 'anomander',
        door: 'telegram',
        text: PHRASED,
        buttons: [],
        channelRef: `telegram:${sent?.messageId}`,
        at: AT,
      },
      {
        id: expect.any(Number),
        from: 'principal',
        door: 'app',
        text: '[foto de ticket] cena',
        buttons: [],
        channelRef: null,
        at: AT,
      },
      {
        id: expect.any(Number),
        from: 'anomander',
        door: 'app',
        text: question.text,
        buttons: question.buttons,
        channelRef: question.channelRef,
        at: AT,
      },
    ]);
    // No image is kept.
    expect(query('SELECT text FROM conversation').map((row) => JSON.stringify(row))).not.toContain(
      png().data,
    );
  });

  it('S4: limit returns the latest messages, at most HISTORY_LIMIT (500)', async () => {
    const db = openDatabase(join(scratch, 'anomander.db'));
    applyMigrations(db);
    const at = new Date().toISOString();
    for (let i = 1; i <= 501; i++) {
      recordMessages(db, [
        { from: 'principal', door: 'app', text: `mensaje ${i}`, buttons: [], channelRef: null, at },
      ]);
    }
    db.close();
    const chat = await client(await start());

    const all = await history(chat);
    expect(all).toHaveLength(HISTORY_LIMIT);
    expect(all[0]?.text).toBe('mensaje 2');
    expect(all.at(-1)?.text).toBe('mensaje 501');
    expect((await history(chat, 2)).map(({ text }) => text)).toEqual([
      'mensaje 500',
      'mensaje 501',
    ]);
    expect(await history(chat, 10_000)).toHaveLength(HISTORY_LIMIT);
    expect((await chat.ask({ type: 'history', limit: 0 })).type).toBe('rejected');
  });

  it('S3: after a restart, the interpreter gets the turns of the last 30 minutes again', async () => {
    const chat = await client(await start());
    await chat.ask({ type: 'text', text: '23 € cena' });
    await anomander?.stop();
    anomander = undefined;

    const again = await client(await start());
    await again.ask({ type: 'text', text: '23 € comida' });

    expect(interpreted.at(-1)?.recent).toEqual([{ principal: '23 € cena', reply: PHRASED }]);
    expect((await history(again)).map(({ text }) => text)).toEqual([
      '23 € cena',
      PHRASED,
      '23 € comida',
      PHRASED,
    ]);
  });

  it('S5: clear_history erases the stored conversation for real and the recent turns, and answers done', async () => {
    const marker = 'zorblaxchatmarker';
    const chat = await client(await start());
    await chat.ask({ type: 'text', text: `23 € cena ${marker}` });
    api.push(updates.text({ chatId: PRINCIPAL }, '23 € merienda'));
    await api.waitForSent(1);
    const path = join(scratch, 'anomander.db');
    const onDisk = (): boolean =>
      [path, `${path}-wal`].some((file) => readFileSync(file).includes(marker));
    expect(onDisk()).toBe(true);

    const id = 'clear-1';
    chat.sendRaw(JSON.stringify({ type: 'clear_history', id }));
    expect(await chat.answerTo(id)).toEqual({ type: 'done', inReplyTo: id });

    expect(await history(chat)).toEqual([]);
    expect(query('SELECT id FROM conversation')).toEqual([]);
    expect(onDisk()).toBe(false);
    await chat.ask({ type: 'text', text: '23 € comida' });
    expect(interpreted.at(-1)?.recent).toEqual([]);
    // Never logged.
    expect(
      JSON.stringify([logger.info, logger.warn, logger.error].flatMap((log) => log.mock.calls)),
    ).not.toContain(marker);
  });

  it('B47: clear_history waits for a Telegram turn in progress, and erases it too', async () => {
    const chat = await client(await start());
    let release = (): void => {};
    interpreting = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    api.push(updates.text({ chatId: PRINCIPAL }, '23 € merienda'));
    await vi.waitFor(() => expect(interpreted).toHaveLength(1));

    const id = 'clear-in-turn';
    chat.sendRaw(JSON.stringify({ type: 'clear_history', id }));
    // Answered outside the turn: once it is, the daemon has the erase too.
    await chat.ask({ type: 'history' });
    release();
    await api.waitForSent(1);

    expect(await chat.answerTo(id)).toEqual({ type: 'done', inReplyTo: id });
    expect(query('SELECT id FROM conversation')).toEqual([]);
  });

  it('when the store cannot be read or erased, answers S-22 and the stored conversation stays', async () => {
    const chat = await client(await start());
    await chat.ask({ type: 'text', text: '23 € cena' });
    const db = new Database(join(scratch, 'anomander.db'));
    db.exec('ALTER TABLE conversation RENAME TO conversation_moved');
    db.close();

    const failed = strings.processingFailed();
    expect(reply(await chat.ask({ type: 'history' })).text).toBe(failed);
    expect(reply(await chat.ask({ type: 'clear_history' })).text).toBe(failed);
    expect(query('SELECT id FROM conversation_moved')).toHaveLength(2);
  });

  it('while setup is incomplete, history is empty and an erase answers S-22', async () => {
    const guide = startSetupGuide(
      { ...config({ ANOMANDER_LOCAL_TOKEN: TOKEN }), localPort: 0 },
      { gaps: [{ kind: 'model_unset' }], telegramApiRoot: api.apiRoot, logger },
    );
    anomander = guide;
    await guide.started;
    const chat = await client(guide);

    expect(await history(chat)).toEqual([]);
    expect((await chat.ask({ type: 'clear_history' })).type).toBe('reply');
  });

  it('rejects a history or clear_history request with fields it does not know', async () => {
    const chat = await client(await start());
    await chat.ask({ type: 'text', text: '23 € cena' });

    expect((await chat.ask({ type: 'history', limit: 'all' })).type).toBe('rejected');
    expect((await chat.ask({ type: 'clear_history', all: true })).type).toBe('rejected');
    expect(query('SELECT id FROM conversation')).toHaveLength(2);
  });
});

// DK-17 (docs/desktop-prd.md): the window's "Gastos" screen asks for the expenses of a month; the
// daemon reads them from the views of RA-1, never the tables, and computes the total itself.
describe('the expenses of a month (DK-17)', () => {
  /** Writes an expense straight into the database, as the views see it. */
  const seed = (
    expenses: {
      on: string;
      cents: number;
      merchant?: string;
      category?: string;
      mode?: string;
      status?: string;
      lines?: number;
    }[],
  ): number[] => {
    const db = new Database(join(scratch, 'anomander.db'));
    const at = '2026-11-20T10:00:00.000Z';
    try {
      return expenses.map((expense) => {
        const document =
          expense.lines === undefined
            ? null
            : db
                .prepare(
                  `INSERT INTO documents (kind, received_at, source, status)
                   VALUES ('receipt', ?, 'telegram:1', 'read')`,
                )
                .run(at).lastInsertRowid;
        const merchant =
          expense.merchant === undefined
            ? null
            : db
                .prepare("INSERT INTO entities (kind, name, created_at) VALUES ('merchant', ?, ?)")
                .run(expense.merchant, at).lastInsertRowid;
        const id = Number(
          db
            .prepare(
              `INSERT INTO expenses (merchant_id, occurred_on, total_cents, category_id, mode,
                 document_id, status, created_at)
               VALUES (?, ?, ?, (SELECT id FROM categories WHERE name = ?), ?, ?, ?, ?)`,
            )
            .run(
              merchant,
              expense.on,
              expense.cents,
              expense.category ?? null,
              expense.mode ?? 'declared',
              document,
              expense.status ?? 'current',
              at,
            ).lastInsertRowid,
        );
        for (let line = 0; line < (expense.lines ?? 0); line += 1) {
          db.prepare(
            'INSERT INTO purchase_lines (expense_id, product_name, quantity, amount_cents) VALUES (?, ?, 1, 100)',
          ).run(id, `LINEA ${line}`);
        }
        return id;
      });
    } finally {
      db.close();
    }
  };

  it('answers the month asked: its current expenses with their mode, the total computed, pending apart', async () => {
    const chat = await client(await start());
    const [cena, ticket, deducido] = seed([
      { on: '2026-10-02', cents: 2300, category: 'restaurantes' },
      { on: '2026-10-31', cents: 450, merchant: 'Mercadona', mode: 'corroborated', lines: 2 },
      {
        on: '2026-10-15',
        cents: 300,
        merchant: 'Café Sol',
        category: 'restaurantes',
        mode: 'inferred',
        lines: 1,
      },
      { on: '2026-09-30', cents: 999 },
      { on: '2026-11-01', cents: 888 },
      { on: '2026-10-10', cents: 1000, status: 'pending' },
      { on: '2026-08-10', cents: 500, status: 'pending' },
      { on: '2026-10-11', cents: 7000, status: 'refuted' },
    ]);

    expect(await chat.ask({ type: 'expenses', month: '2026-10' })).toEqual({
      type: 'expenses',
      inReplyTo: expect.any(String),
      month: '2026-10',
      expenses: [
        {
          id: cena,
          date: '2026-10-02',
          merchant: null,
          category: 'restaurantes',
          totalCents: 2300,
          mode: 'declared',
          origin: 'text',
          lines: 0,
        },
        {
          id: deducido,
          date: '2026-10-15',
          merchant: 'Café Sol',
          category: 'restaurantes',
          totalCents: 300,
          mode: 'inferred',
          origin: 'receipt',
          lines: 1,
        },
        {
          id: ticket,
          date: '2026-10-31',
          merchant: 'Mercadona',
          category: null,
          totalCents: 450,
          mode: 'corroborated',
          origin: 'receipt',
          lines: 2,
        },
      ],
      totalCents: 3050,
      // RA-1 AC3: the view counts every pending expense, whatever its month (as R-10 AC2 does).
      pending: { count: 2, totalCents: 1500 },
    });
  });

  it('without a month, answers the current month in TZ', async () => {
    // 23:30 UTC on 30 November is already 1 December in Madrid.
    const chat = await client(
      await start(
        { ANOMANDER_LOCAL_TOKEN: TOKEN, TZ: 'Europe/Madrid' },
        { now: () => new Date('2026-11-30T23:30:00.000Z') },
      ),
    );
    seed([
      { on: '2026-11-30', cents: 100 },
      { on: '2026-12-01', cents: 250 },
    ]);

    const answer = await chat.ask({ type: 'expenses' });
    expect(answer).toMatchObject({ type: 'expenses', month: '2026-12', totalCents: 250 });
  });

  it('when the views cannot be read, answers S-22 and logs no expense', async () => {
    const chat = await client(await start());
    seed([{ on: '2026-11-02', cents: 2300, merchant: 'Casa Pepe' }]);
    const db = new Database(join(scratch, 'anomander.db'));
    db.exec('DROP VIEW gastos');
    db.close();

    expect(reply(await chat.ask({ type: 'expenses', month: '2026-11' })).text).toBe(
      strings.processingFailed(),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('Casa Pepe');
  });

  it('rejects a month that is not YYYY-MM, or fields it does not know', async () => {
    const chat = await client(await start());

    expect((await chat.ask({ type: 'expenses', month: '2026-13' })).type).toBe('rejected');
    expect((await chat.ask({ type: 'expenses', month: '2026-1' })).type).toBe('rejected');
    expect((await chat.ask({ type: 'expenses', all: true })).type).toBe('rejected');
  });
});

describe('a text pasted in the app while a Telegram login waits (R-17 AC7, R-27 AC3)', () => {
  it('goes to the login first: answered done, never stored, logged, a recent turn or sent to the model', async () => {
    const pasted = 'http://127.0.0.1:1455/auth/callback?code=zorbpasted&state=s';
    const token: Credential = { type: 'oauth', access: 'a', refresh: 'r', expires: 1 };
    let received: string | undefined;
    const models: ModelLogin = {
      login: async (_providerId, _type, interaction) => {
        interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' });
        received = await interaction.prompt({
          type: 'manual_code',
          message: 'Paste the redirect URL',
          ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
        });
        return token;
      },
      logout: async () => {},
    };
    const daemon = await start(undefined, {
      login: {
        models,
        credentials: createFileCredentialStore(join(scratch, 'auth.json')),
        getDeviceId: () => '00000000-0000-4000-8000-000000000000',
        timeoutMs: 60_000,
      },
    });
    const chat = await client(daemon);
    api.push(updates.text({ chatId: PRINCIPAL }, '/login'));
    const [choose] = await api.waitForSent(1);
    api.push(updates.callbackQuery({ chatId: PRINCIPAL }, 'login:openai', choose?.messageId ?? 0));
    await api.waitForSent(2);

    const answer = await chat.ask({ type: 'text', text: pasted });

    expect(answer.type).toBe('done');
    await vi.waitFor(() => expect(received).toBe(pasted));
    expect(interpreted).toEqual([]);
    expect(query('SELECT id FROM conversation')).toEqual([]);
    const path = join(scratch, 'anomander.db');
    expect(
      [path, `${path}-wal`, `${path}-shm`].some((file) => {
        try {
          return readFileSync(file).includes('zorbpasted');
        } catch {
          return false;
        }
      }),
    ).toBe(false);
    expect(
      JSON.stringify([logger.info, logger.warn, logger.error].flatMap((log) => log.mock.calls)),
    ).not.toContain('zorbpasted');
    await chat.ask({ type: 'text', text: '23 € cena' });
    expect(interpreted.map(({ message, recent }) => ({ message, recent }))).toEqual([
      { message: '23 € cena', recent: [] },
    ]);
  });

  it('never starts a login from the app: /login there is not a login route (DK-4 AC7)', async () => {
    const daemon = await start(undefined, {
      login: {
        models: { login: async () => Promise.reject(new Error('no')), logout: async () => {} },
        credentials: createFileCredentialStore(join(scratch, 'auth.json')),
        getDeviceId: () => '00000000-0000-4000-8000-000000000000',
        timeoutMs: 60_000,
      },
    });
    const chat = await client(daemon);

    const answer = reply(await chat.ask({ type: 'text', text: '/login' }));

    expect(JSON.stringify(answer.buttons)).not.toContain('login:');
    expect(api.sent).toEqual([]);
  });
});

// T13: the desktop app without a Telegram bot. The local channel is the only front door.
describe('without Telegram', () => {
  const alone = () => ({
    ...loadConfig({
      ANOMANDER_LOCAL_TOKEN: TOKEN,
      ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
      ANOMANDER_MODEL: 'openai/gpt-4o-mini',
      ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
    }),
    localPort: 0,
  });

  it('answers the chat as with a bot, and its polling ends only when it stops', async () => {
    const daemon = startAnomander(alone(), { complete, model: 'openai/gpt-4o-mini', logger });
    anomander = daemon;
    await daemon.started;
    let polled = false;
    daemon.polling.then(() => {
      polled = true;
    });
    const chat = await client(daemon);

    expect(reply(await chat.ask({ type: 'text', text: '23 € cena' })).text).toBe(PHRASED);
    await vi.waitFor(() =>
      expect(query("SELECT status FROM actions WHERE status = 'verified'")).toHaveLength(1),
    );
    expect(reply(await chat.ask({ type: 'text', text: '/start' })).text).toBe('¡Hola!');
    expect(polled).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();

    await daemon.stop();
    anomander = undefined;
    await daemon.polling;
  });

  it('answers with the setup guide while no model is usable, without sending it anywhere (R-28)', async () => {
    const guide = startSetupGuide(alone(), { gaps: [{ kind: 'model_unset' }], logger });
    anomander = guide;
    await guide.started;
    const chat = await client(guide);

    expect(reply(await chat.ask({ type: 'text', text: 'hola' })).text).toContain('ANOMANDER_MODEL');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('setup incomplete'));
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('a question about the screen', () => {
  const question = '¿De quién es este correo?';

  it('answers what the vision model sees in the capture, without tools and without storing anything', async () => {
    const chat = await client(await start());
    const image = png();

    const answer = reply(await chat.ask({ type: 'screen', text: question, image }));

    expect(answer.text).toBe(SEEN);
    expect(answer.buttons).toEqual([]);
    expect(screens).toHaveLength(1);
    const [context] = screens;
    expect(context).not.toHaveProperty('tools');
    expect(context?.messages).toHaveLength(1);
    // DK-14 AC1: with what ANOMANDER remembers, here nothing.
    expect(context?.messages[0]?.content).toEqual([
      { type: 'text', text: JSON.stringify({ question, memories: [] }) },
      { type: 'image', mimeType: 'image/png', data: image.data },
    ]);
    // Looking is not recording: no expense, and the capture is not kept.
    expect(query('SELECT id FROM expenses')).toEqual([]);
    expect(api.sent).toEqual([]);
  });

  it('is a recent turn, so the next message can refer to it (R-16 AC3)', async () => {
    const chat = await client(await start());
    await chat.ask({ type: 'screen', text: question, image: png() });

    await chat.ask({ type: 'text', text: '23 € cena' });

    expect(interpreted.at(-1)?.recent).toEqual([
      { principal: `[captura de pantalla] ${question}`, reply: SEEN },
    ]);
  });

  it('says it could not look when the vision model fails or answers nothing', async () => {
    const chat = await client(await start());

    seen = async () => {
      throw new Error('the provider is down');
    };
    expect(reply(await chat.ask({ type: 'screen', text: question, image: png() })).text).toBe(
      NOT_SEEN,
    );

    seen = async () => '  ';
    expect(reply(await chat.ask({ type: 'screen', text: question, image: png() })).text).toBe(
      NOT_SEEN,
    );
  });

  it('counts against the daily AI limit (R-12)', async () => {
    const chat = await client(
      await start({ ANOMANDER_LOCAL_TOKEN: TOKEN, ANOMANDER_DAILY_AI_CALL_LIMIT: '1' }),
    );

    expect(reply(await chat.ask({ type: 'screen', text: question, image: png() })).text).toBe(SEEN);
    expect(reply(await chat.ask({ type: 'screen', text: question, image: png() })).text).toBe(
      'He llegado al límite diario de IA y hoy no puedo procesar más mensajes. ¿Me lo vuelves a enviar mañana?',
    );
    expect(screens).toHaveLength(1);
  });

  it('rejects a capture that is not an image, or a question without words', async () => {
    const chat = await client(await start());

    const notImage = { mimeType: 'application/pdf', data: png().data };
    expect((await chat.ask({ type: 'screen', text: question, image: notImage })).type).toBe(
      'rejected',
    );
    expect((await chat.ask({ type: 'screen', text: '', image: png() })).type).toBe('rejected');
    expect(screens).toEqual([]);
  });

  it('answers with the setup guide while no model is usable (R-28)', async () => {
    const guide = startSetupGuide(
      { ...config({ ANOMANDER_LOCAL_TOKEN: TOKEN }), localPort: 0 },
      { gaps: [{ kind: 'model_unset' }], telegramApiRoot: api.apiRoot, logger },
    );
    anomander = guide;
    await guide.started;
    const chat = await client(guide);

    const sent = await api.waitForSent(1);
    expect(reply(await chat.ask({ type: 'screen', text: question, image: png() })).text).toBe(
      sent[0]?.text,
    );
  });
});

describe('a task on the computer (DK-10)', () => {
  const task = 'Envía el correo que tengo abierto';
  const ask = (chat: Awaited<ReturnType<typeof client>>, done: string[] = []) =>
    chat.ask({ type: 'computer', task, image: png(), done });

  it('AC2: proposes one action from the capture, without tools, and does nothing itself', async () => {
    const chat = await client(await start());
    const image = png();

    const answer = reply(await chat.ask({ type: 'computer', task, image, done: ['Paso uno'] }));

    expect(answer.text).toBe('Quiero hacer clic en «Enviar».');
    expect(answer.computer).toEqual(CLICK);
    expect(plans).toHaveLength(1);
    const [context] = plans;
    expect(context).not.toHaveProperty('tools');
    expect(context?.messages).toHaveLength(1);
    expect(context?.messages[0]?.content).toEqual([
      // DK-14 AC1: with what ANOMANDER remembers, here nothing.
      { type: 'text', text: JSON.stringify({ task, done: ['Paso uno'], memories: [] }) },
      { type: 'image', mimeType: 'image/png', data: image.data },
    ]);
    expect(query('SELECT id FROM expenses')).toEqual([]);
    expect(api.sent).toEqual([]);
  });

  it('AC3: says in code what each action is, with the exact text or keys', async () => {
    const chat = await client(await start());
    const proposes = async (action: Record<string, unknown>) => {
      planned = async () => JSON.stringify(action);
      return reply(await ask(chat));
    };

    const double = await proposes({ ...CLICK, double: true });
    expect(double.text).toBe('Quiero hacer doble clic en «Enviar».');

    const typing = await proposes({ kind: 'type', text: 'Hola, Marta:' });
    expect(typing.text).toBe('Quiero escribir: «Hola, Marta:»');
    expect(typing.computer).toEqual({ kind: 'type', text: 'Hola, Marta:' });

    const keys = await proposes({ kind: 'key', key: 'c', modifiers: ['cmd', 'shift'] });
    expect(keys.text).toBe('Quiero pulsar ⇧⌘C.');
    expect((await proposes({ kind: 'key', key: 'enter', modifiers: [] })).text).toBe(
      'Quiero pulsar Intro.',
    );

    const scroll = await proposes({ kind: 'scroll', x: 500, y: 500, direction: 'down' });
    expect(scroll.text).toBe('Quiero desplazar la pantalla hacia abajo.');
    expect(scroll.computer).toEqual({ kind: 'scroll', x: 500, y: 500, direction: 'down' });
  });

  it('AC1: a routine step needs no permission; a step of care always does', async () => {
    const chat = await client(await start());
    const confirms = async (action: Record<string, unknown>) => {
      planned = async () => JSON.stringify(action);
      const answer = reply(await ask(chat));
      // What is performed never carries the processor's own judgement.
      expect(answer.computer).not.toHaveProperty('sensitive');
      return answer.confirm;
    };
    const click = (target: string, sensitive = false) => ({ ...CLICK, target, sensitive });
    const key = (name: string, modifiers: string[] = []) => ({
      kind: 'key',
      key: name,
      modifiers,
      sensitive: false,
    });

    // Routine, by the processor's word and by the code's own look.
    expect(await confirms(click('Barra de direcciones'))).toBe(false);
    expect(await confirms({ kind: 'type', text: 'tiempo en Madrid', sensitive: false })).toBe(
      false,
    );
    expect(await confirms(key('tab'))).toBe(false);
    expect(await confirms(key('escape'))).toBe(false);
    expect(await confirms(key('down'))).toBe(false);
    expect(await confirms(key('l', ['cmd']))).toBe(false);
    expect(await confirms(key('t', ['cmd']))).toBe(false);
    expect(
      await confirms({ kind: 'scroll', x: 500, y: 500, direction: 'down', sensitive: false }),
    ).toBe(false);

    // The processor says it is of care.
    expect(await confirms(click('Barra de direcciones', true))).toBe(true);
    // The processor did not say: asking is the default.
    expect(await confirms({ ...CLICK, target: 'Barra de direcciones' })).toBe(true);

    // The code asks whatever the processor says: what the control is called...
    for (const target of [
      'Enviar',
      'Botón ENVIAR mensaje',
      'Pagar ahora',
      'Comprar',
      'Eliminar',
      'Borrar todo',
      'Aceptar',
      'Confirmar pedido',
      'Instalar',
      'Publicar',
      'Send',
      'Delete',
      'Buy now',
      'Vaciar papelera',
      'Cerrar sesión',
      'Contraseña',
      'Guardar',
      'No guardar',
      'Submit',
      'OK',
      'Sí',
      'Continuar',
      'Responder',
      'Reenviar',
      'Compartir',
      'Finalizar compra',
      'Checkout',
      'Trash',
      'Quitar',
      'Salir de Chrome',
      'Aplicar',
      'Estoy de acuerdo',
      'Donar',
      'Reservar',
      'Firmar',
      'Bizum',
      'Descargar',
      'Ejecutar',
      'Reemplazar',
      'Darse de baja',
      'Entrar',
      'Registrarse',
      'Tarjeta',
      'Retirar',
      'Confiar',
    ]) {
      expect(await confirms(click(target)), target).toBe(true);
    }
    // ...and a shortcut that is not one of the harmless ones.
    expect(await confirms(key('q', ['cmd']))).toBe(true);
    expect(await confirms(key('w', ['cmd']))).toBe(true);
    expect(await confirms(key('enter', ['cmd']))).toBe(true);
    expect(await confirms(key('backspace', ['cmd']))).toBe(true);
    expect(await confirms(key('c', ['cmd', 'shift']))).toBe(true);
    expect(await confirms(key('c', ['ctrl']))).toBe(true);
    // Reloading can send a form again, and pasting writes what nobody was shown.
    expect(await confirms(key('r', ['cmd']))).toBe(true);
    expect(await confirms(key('v', ['cmd']))).toBe(true);
    // Enter and Space press whatever has the focus: a Send button, a default button, a message
    // box that sends on Enter. The code cannot see which, so it always asks.
    expect(await confirms(key('enter'))).toBe(true);
    expect(await confirms(key('space'))).toBe(true);
    // With Shift held they still press it: Shift+Enter submits a form in a browser.
    expect(await confirms(key('enter', ['shift']))).toBe(true);
    expect(await confirms(key('space', ['shift']))).toBe(true);
    expect(await confirms(key('enter', ['shift', 'shift']))).toBe(true);
    // Spotlight and the app switcher change which app the next keys go to.
    expect(await confirms(key('space', ['cmd']))).toBe(true);
    expect(await confirms(key('tab', ['cmd']))).toBe(true);
    // A name that only looks like a word of care is still routine.
    for (const target of ['Aplicaciones', 'Centrar', 'Configuración', 'Tokio', 'Google Chrome']) {
      expect(await confirms(click(target)), target).toBe(false);
    }
  });

  it('AC1: every fifth step waits for the principal, however routine it looks', async () => {
    const chat = await client(await start());
    planned = async () =>
      JSON.stringify({ kind: 'scroll', x: 500, y: 500, direction: 'down', sensitive: false });
    const confirmsAfter = async (steps: number) =>
      reply(
        await ask(
          chat,
          Array.from({ length: steps }, (_, n) => `Paso ${n + 1}`),
        ),
      ).confirm;

    expect(await confirmsAfter(3)).toBe(false);
    expect(await confirmsAfter(4)).toBe(true);
    expect(await confirmsAfter(5)).toBe(false);
    expect(await confirmsAfter(9)).toBe(true);
  });

  it('ends a task in words, with no action, and that end is a recent turn', async () => {
    const chat = await client(await start());
    planned = async () => JSON.stringify({ kind: 'done', message: 'Correo enviado.' });

    const end = reply(await ask(chat, ['Quiero hacer clic en «Enviar».']));
    expect(end.text).toBe('Correo enviado.');
    expect(end).not.toHaveProperty('computer');

    planned = async () => JSON.stringify({ kind: 'cannot', message: 'No veo ningún correo.' });
    expect(reply(await ask(chat)).text).toBe('No veo ningún correo.');

    await chat.ask({ type: 'text', text: '23 € cena' });
    expect(interpreted.at(-1)?.recent).toEqual([
      { principal: `[control del ordenador] ${task}`, reply: 'Correo enviado.' },
      { principal: `[control del ordenador] ${task}`, reply: 'No veo ningún correo.' },
    ]);
  });

  it('proposes nothing when the plan is not exactly one valid action', async () => {
    const chat = await client(await start());
    const FAILED = 'No he sabido qué hacer en tu ordenador. ¿Me lo pides de otra forma?';
    const invalid = [
      'haz clic en enviar',
      JSON.stringify({ ...CLICK, x: 1001 }),
      JSON.stringify({ ...CLICK, y: -1 }),
      JSON.stringify({ ...CLICK, x: 1.5 }),
      JSON.stringify({ ...CLICK, shell: 'rm -rf' }),
      JSON.stringify({ kind: 'run', command: 'rm -rf ~' }),
      JSON.stringify({ kind: 'type', text: '' }),
      JSON.stringify({ kind: 'type', text: 'x'.repeat(501) }),
      // AC3: what is typed is exactly what is shown. A line break would be an Enter nobody
      // read, and a control or direction character would hide what the text is.
      JSON.stringify({ kind: 'type', text: 'rm -rf ~/Documents\n' }),
      JSON.stringify({ kind: 'type', text: 'a\tb' }),
      JSON.stringify({ kind: 'type', text: 'a\u001bb' }),
      JSON.stringify({ kind: 'type', text: 'abc\u202Edef' }),
      JSON.stringify({ kind: 'type', text: '   ' }),
      // Line and paragraph separators, and the letters that show as nothing.
      JSON.stringify({ kind: 'type', text: 'a\u2028b' }),
      JSON.stringify({ kind: 'type', text: 'a\u2029b' }),
      JSON.stringify({ kind: 'type', text: 'a\u3164b' }),
      JSON.stringify({ kind: 'type', text: 'a\u034Fb' }),
      JSON.stringify({ kind: 'type', text: 'a\u{E0041}b' }),
      JSON.stringify({ ...CLICK, target: 'Cancelar\u2028Enviar' }),
      // The target is quoted in the description: it cannot leave its quotes or its line.
      JSON.stringify({ ...CLICK, target: 'Cancelar».\n\nEs seguro' }),
      JSON.stringify({ ...CLICK, target: 'Cancelar» «Enviar' }),
      JSON.stringify({ ...CLICK, target: 'Enviar\u202E' }),
      JSON.stringify({ kind: 'key', key: 'f13', modifiers: [] }),
      JSON.stringify({ kind: 'key', key: 'c', modifiers: ['hyper'] }),
      JSON.stringify([CLICK, CLICK]),
    ];
    for (const plan of invalid) {
      planned = async () => plan;
      const answer = reply(await ask(chat));
      expect(answer.text, plan).toBe(FAILED);
      expect(answer, plan).not.toHaveProperty('computer');
    }

    planned = async () => {
      throw new Error('the provider is down');
    };
    expect(reply(await ask(chat)).text).toBe(FAILED);
  });

  it('says so when the AI provider takes no more requests, for a task and for a look', async () => {
    const chat = await client(await start());
    const QUOTA =
      'Tu proveedor de IA no acepta más peticiones por ahora: has agotado su cuota. Prueba más tarde o revisa tu plan.';
    const refused = async () => {
      throw new Error('{"error":{"code":429,"message":"You exceeded your current quota"}}');
    };

    planned = refused;
    const step = reply(await ask(chat));
    expect(step.text).toBe(QUOTA);
    expect(step).not.toHaveProperty('computer');

    seen = refused;
    expect(reply(await chat.ask({ type: 'screen', text: '¿Qué ves?', image: png() })).text).toBe(
      QUOTA,
    );
  });

  it('AC4: stops after 12 steps without asking the planner again', async () => {
    const chat = await client(await start());
    const done = Array.from({ length: 12 }, (_, index) => `Paso ${index + 1}`);

    const answer = reply(await ask(chat, done));

    expect(answer.text).toBe(
      'He llegado al máximo de 12 pasos seguidos y paro aquí. Si quieres que siga, pídemelo otra vez.',
    );
    expect(answer).not.toHaveProperty('computer');
    expect(plans).toEqual([]);
    expect((await ask(chat, [...done, 'Paso 13'])).type).toBe('rejected');
  });

  it('counts each step against the daily AI limit (R-12)', async () => {
    const chat = await client(
      await start({ ANOMANDER_LOCAL_TOKEN: TOKEN, ANOMANDER_DAILY_AI_CALL_LIMIT: '1' }),
    );

    expect(reply(await ask(chat)).computer).toEqual(CLICK);
    const second = reply(await ask(chat));
    expect(second.text).toBe(
      'He llegado al límite diario de IA y hoy no puedo procesar más mensajes. ¿Me lo vuelves a enviar mañana?',
    );
    expect(second).not.toHaveProperty('computer');
  });

  it('rejects a task without words or without an image', async () => {
    const chat = await client(await start());

    expect((await chat.ask({ type: 'computer', task: ' ', image: png(), done: [] })).type).toBe(
      'rejected',
    );
    const pdf = { mimeType: 'application/pdf', data: png().data };
    expect((await chat.ask({ type: 'computer', task, image: pdf, done: [] })).type).toBe(
      'rejected',
    );
    expect(plans).toEqual([]);
  });

  it('answers with the setup guide while no model is usable (R-28)', async () => {
    const guide = startSetupGuide(
      { ...config({ ANOMANDER_LOCAL_TOKEN: TOKEN }), localPort: 0 },
      { gaps: [{ kind: 'model_unset' }], telegramApiRoot: api.apiRoot, logger },
    );
    anomander = guide;
    await guide.started;
    const chat = await client(guide);

    const sent = await api.waitForSent(1);
    const answer = reply(await ask(chat));
    expect(answer.text).toBe(sent[0]?.text);
    expect(answer).not.toHaveProperty('computer');
  });
});

describe('a request the chat routes by itself (DK-13)', () => {
  const route = (to: string, task: string) => JSON.stringify({ kind: 'route', to, task });
  const calendar = (): Connection => ({
    name: 'calendar',
    tools: [{ name: 'events', description: 'events', inputSchema: { type: 'object' } }],
    readOnly: new Set(['events']),
    call: async () => ({ text: 'dentista a las 10', isError: false }),
  });
  const says = (text: string): AssistantMessage['content'] => [{ type: 'text', text }];

  it('AC1, AC2: the app offers every way, and starts a look or a task on the computer itself', async () => {
    const chat = await client(await start());

    routed = route('computer', ' abre Safari ');
    const task = reply(await chat.ask({ type: 'text', text: 'abre Safari' }));
    routed = route('screen', '¿qué error me sale?');
    const look = reply(await chat.ask({ type: 'text', text: '¿qué error me sale?' }));

    expect(task).toMatchObject({
      text: 'Me pongo con ello en tu ordenador.',
      buttons: [],
      route: { to: 'computer', task: 'abre Safari' },
    });
    expect(look).toMatchObject({
      text: 'Miro tu pantalla.',
      route: { to: 'screen', task: '¿qué error me sale?' },
    });
    expect(interpreted.map(({ routes }) => routes)).toEqual([
      ['screen', 'computer', 'connect'],
      ['screen', 'computer', 'connect'],
    ]);
    expect(query('SELECT id FROM expenses')).toEqual([]);
    expect(plans).toEqual([]);
    expect(screens).toEqual([]);
  });

  it('AC2: a task with connections asked in words runs as a `connect` request does', async () => {
    connected = [calendar()];
    const chat = await client(await start());
    routed = route('connect', 'qué tengo mañana');
    tooled = [
      [{ type: 'toolCall', id: 'call-1', name: 'calendar__events', arguments: {} }],
      says('Mañana tienes dentista a las 10.'),
    ];

    const answer = reply(await chat.ask({ type: 'text', text: '¿qué tengo mañana?' }));

    expect(answer.text).toBe('Mañana tienes dentista a las 10.');
    expect(answer).not.toHaveProperty('route');
    expect(api.sent).toEqual([]);
    // B50: what the principal typed is stored once, with no `[conexiones]` line of its own.
    expect(query('SELECT sender, text FROM conversation ORDER BY id')).toEqual([
      { sender: 'principal', text: '¿qué tengo mañana?' },
      { sender: 'anomander', text: 'Lo miro en tus conexiones.' },
      { sender: 'anomander', text: 'Mañana tienes dentista a las 10.' },
    ]);
  });

  it('AC1, AC2: Telegram offers only connections, and answers a task asked there', async () => {
    connected = [calendar()];
    await start();
    routed = route('connect', 'qué tengo mañana');
    tooled = [says('Mañana tienes dentista a las 10.')];

    let release = (): void => {};
    held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });

    api.push(updates.text({ chatId: PRINCIPAL }, '¿qué tengo mañana?'));

    // The way is announced at once, while the task still runs, and the answer follows when the
    // task ends: in that order.
    expect((await api.waitForSent(1)).map(({ text }) => text)).toEqual([
      'Lo miro en tus conexiones.',
    ]);
    await vi.waitFor(() => expect(tasked).toHaveLength(1));
    release();
    expect((await api.waitForSent(2)).map(({ text }) => text)).toEqual([
      'Lo miro en tus conexiones.',
      'Mañana tienes dentista a las 10.',
    ]);
    expect(interpreted.at(-1)?.routes).toEqual(['connect']);
    // B50: what the principal typed is stored once, then each message the bot sent.
    await vi.waitFor(() =>
      expect(query('SELECT sender, door, text FROM conversation ORDER BY id')).toEqual([
        { sender: 'principal', door: 'telegram', text: '¿qué tengo mañana?' },
        { sender: 'anomander', door: 'telegram', text: 'Lo miro en tus conexiones.' },
        { sender: 'anomander', door: 'telegram', text: 'Mañana tienes dentista a las 10.' },
      ]),
    );
  });

  it('AC1: a look or a task on the computer asked in Telegram says it is done in the app', async () => {
    await start();
    routed = route('computer', 'abre Safari');

    api.push(updates.text({ chatId: PRINCIPAL }, 'abre Safari'));

    expect((await api.waitForSent(1)).at(-1)?.text).toBe(
      'Eso solo puedo hacerlo desde la app de ANOMANDER en tu Mac.',
    );
    expect(plans).toEqual([]);
  });
});

describe('a search on the web (T17)', () => {
  // The principal's own message, as they wrote it.
  const asked = 'Buscame donde puedo encontrar el dragons doma 2 para la switch 2 al mejor precio';
  const route = (to: string, task: string) => JSON.stringify({ kind: 'route', to, task });
  const says = (text: string): AssistantMessage['content'] => [{ type: 'text', text }];

  /** The web search connection as the app adds it, started from a stand-in that reaches nothing. */
  const withWebSearch = () => {
    const path = join(scratch, 'mcp.json');
    const { name, args, env, readOnly } = WEB_SEARCH_CONNECTION;
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          [name]: {
            command: process.execPath,
            // The stand-in ignores the preset's arguments, which name the package it stands for.
            args: [resolve(FIXTURES, 'mcp-web-search-server.mjs'), ...args],
            env,
            readOnly,
          },
        },
      }),
    );
    return { ANOMANDER_LOCAL_TOKEN: TOKEN, ANOMANDER_MCP_CONFIG: path };
  };

  it('routes the lookup to the web search connection and searches without "Permitir"', async () => {
    const chat = await client(await start(withWebSearch(), {}, true));
    routed = route('connect', asked);
    tooled = [
      [
        {
          type: 'toolCall',
          id: 'call-1',
          name: `${WEB_SEARCH_CONNECTION.name}__web_search`,
          arguments: { query: 'Dragons Dogma 2 Switch 2 precio' },
        },
      ],
      says('El mejor precio que he visto es 49,99 €.'),
    ];

    const answer = reply(await chat.ask({ type: 'text', text: asked }));

    expect(answer.text).toBe('El mejor precio que he visto es 49,99 €.');
    expect(answer.buttons).toEqual([]);
    expect(answer).not.toHaveProperty('route');
    expect(plans).toEqual([]);
    // The search ran by itself, and its answer reached the task.
    expect(JSON.stringify(tasked.at(-1)?.messages)).toContain(
      'results for: Dragons Dogma 2 Switch 2 precio',
    );
    // Before the first task the processor knew the server's read-only tools, unconnected; after
    // it, what the server says each one does.
    expect(interpreted.at(-1)?.connected).toEqual(
      WEB_SEARCH_CONNECTION.readOnly.map((tool) => ({
        server: WEB_SEARCH_CONNECTION.name,
        tool,
        purpose: '',
      })),
    );
    await chat.ask({ type: 'text', text: 'hola' });
    expect(interpreted.at(-1)?.connected).toContainEqual({
      server: WEB_SEARCH_CONNECTION.name,
      tool: 'web_search',
      purpose: 'Search the web for sources or answers.',
    });
  });

  it('still asks before a tool of that connection not marked read-only', async () => {
    const chat = await client(await start(withWebSearch(), {}, true));
    tooled = [
      [
        {
          type: 'toolCall',
          id: 'call-1',
          name: `${WEB_SEARCH_CONNECTION.name}__source_check`,
          arguments: { claim: 'cuesta 49,99 €' },
        },
      ],
    ];

    const question = reply(await chat.ask({ type: 'connect', task: asked }));

    expect(question.buttons.map((button) => button.label)).toEqual(['Permitir', 'Detener']);
  });

  it('asks before reading a page, showing its exact address, and before a search that picks a provider or a proxy', async () => {
    const chat = await client(await start(withWebSearch(), {}, true));
    const toolCall = (
      tool: string,
      args: Record<string, string | boolean>,
    ): AssistantMessage['content'] => [
      {
        type: 'toolCall',
        id: `call-${tool}`,
        name: `${WEB_SEARCH_CONNECTION.name}__${tool}`,
        arguments: args,
      },
    ];
    const url = 'https://www.example.com/dragons-dogma-2?ref=switch';

    tooled = [toolCall('fetch_content', { url })];
    const page = reply(await chat.ask({ type: 'connect', task: asked }));
    expect(page.text).toBe(
      `Quiero usar «fetch_content» de «${WEB_SEARCH_CONNECTION.name}» con:\n{\n  "url": "${url}"\n}`,
    );
    expect(page.buttons.map((button) => button.label)).toEqual(['Permitir', 'Detener']);

    for (const args of [
      { query: 'precio', proxy: 'http://127.0.0.1:9' },
      { query: 'precio', provider: 'duckduckgo' },
      { query: 'precio', includeContent: true },
    ]) {
      tooled = [toolCall('web_search', args)];
      const question = reply(await chat.ask({ type: 'connect', task: asked }));
      expect(question.buttons.map((button) => button.label)).toEqual(['Permitir', 'Detener']);
    }
    expect(JSON.stringify(tasked.map(({ messages }) => messages))).not.toContain('results for:');
  });

  it('in Telegram too, with no connection that searches, suggests adding one', async () => {
    await start();
    routed = JSON.stringify({ kind: 'no_web_search' });

    api.push(updates.text({ chatId: PRINCIPAL }, asked));

    const sent = (await api.waitForSent(1)).at(-1);
    expect(sent?.text).toBe(
      'Para buscar en internet necesito la conexión de búsqueda web. Añádela en Conexiones, en la app de ANOMANDER, y vuelve a pedírmelo.',
    );
    // DK-11 AC13: the press that adds it is the app's; the bot gets no button.
    expect(sent?.payload.reply_markup).toBeUndefined();
    expect(interpreted.at(-1)?.routes).toEqual(['connect']);
    expect(tasked).toEqual([]);
  });

  it('with no connection that searches, suggests adding one and starts nothing on the computer', async () => {
    const chat = await client(await start());
    routed = JSON.stringify({ kind: 'no_web_search' });

    const answer = reply(await chat.ask({ type: 'text', text: asked }));

    expect(answer.text).toBe(
      'Para buscar en internet necesito la conexión de búsqueda web. Añádela en Conexiones, en la app de ANOMANDER, y vuelve a pedírmelo.',
    );
    expect(answer).not.toHaveProperty('route');
    // DK-11 AC13: the app offers to add it in one press.
    expect(answer.offer).toBe('web_search');
    expect(interpreted.at(-1)?.connected).toEqual([]);
    expect(plans).toEqual([]);
    expect(tasked).toEqual([]);
  });
});

describe('a task with connections (DK-11)', () => {
  const task = 'Apunta en mis notas el hotel de Lisboa';
  let made: { tool: string; args: unknown }[];
  const notes = (): Connection => ({
    name: 'notes',
    tools: ['search', 'create'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
    })),
    readOnly: new Set(['search']),
    call: async (tool, args) => {
      made.push({ tool, args });
      return { text: `result of ${tool}`, isError: false };
    },
  });
  const calls = (name: string, args: Record<string, string>): AssistantMessage['content'] => [
    { type: 'toolCall', id: `call-${name}`, name, arguments: args },
  ];
  const says = (text: string): AssistantMessage['content'] => [{ type: 'text', text }];

  beforeEach(() => {
    made = [];
    connected = [notes()];
  });

  it('answers in words once the processor calls no more tools, and that end is a recent turn', async () => {
    const chat = await client(await start());
    tooled = [calls('notes__search', { query: 'Lisboa' }), says('No hay ninguna nota de Lisboa.')];

    const answer = reply(await chat.ask({ type: 'connect', task }));

    expect(answer.text).toBe('No hay ninguna nota de Lisboa.');
    expect(answer.buttons).toEqual([]);
    expect(made).toEqual([{ tool: 'search', args: { query: 'Lisboa' } }]);
    expect(query('SELECT id FROM expenses')).toEqual([]);
    expect(api.sent).toEqual([]);

    await chat.ask({ type: 'text', text: '23 € cena' });
    expect(interpreted.at(-1)?.recent).toEqual([
      { principal: `[conexiones] ${task}`, reply: 'No hay ninguna nota de Lisboa.' },
    ]);
  });

  // T15: the turn that tells a running step's end is let in after a stop began (`ends`).
  it('a step that runs when the daemon stops is still told and kept before the store closes', async () => {
    const daemon = await start();
    const chat = await client(daemon);
    tooled = [says('No hay ninguna nota de Lisboa.')];
    let release = (): void => {};
    held = new Promise<void>((resolveStep) => {
      release = resolveStep;
    });
    void chat.ask({ type: 'connect', task }).catch(() => {});
    await vi.waitFor(() => expect(tasked).toHaveLength(1));

    const stopped = daemon.stop();
    anomander = undefined;
    setTimeout(release, 50);
    await stopped;

    expect(query('SELECT task, outcome FROM action_history')).toEqual([
      { task, outcome: 'answer' },
    ]);
    expect(logger.error.mock.calls.map(([message]) => message)).toEqual([]);
  });

  it('asks before a call that is not read-only, and makes it once on "Permitir"', async () => {
    const chat = await client(await start());
    tooled = [calls('notes__create', { title: 'Hotel Sol' }), says('Apuntado.')];

    const question = reply(await chat.ask({ type: 'connect', task }));

    expect(made).toEqual([]);
    expect(question.text).toBe(
      'Quiero usar «create» de «notes» con:\n{\n  "title": "Hotel Sol"\n}',
    );
    expect(question.buttons.map((button) => button.label)).toEqual(['Permitir', 'Detener']);
    const [allow] = question.buttons;
    if (allow === undefined || !('data' in allow)) throw new Error('no button to allow');
    expect(allow.data).toMatch(/^connection:[0-9a-f-]{36}:allow$/);

    const press = { type: 'button' as const, data: allow.data, channelRef: question.channelRef };
    expect(reply(await chat.ask(press)).text).toBe('Apuntado.');
    expect(made).toEqual([{ tool: 'create', args: { title: 'Hotel Sol' } }]);

    expect(reply(await chat.ask(press)).text).toBe('Esa petición ya no está pendiente.');
    expect(made).toHaveLength(1);
  });

  it('is answered in the app only: the same press from Telegram runs nothing', async () => {
    const chat = await client(await start());
    tooled = [calls('notes__create', { title: 'Hotel Sol' }), says('Apuntado.')];
    const question = reply(await chat.ask({ type: 'connect', task }));
    const [allow] = question.buttons;
    if (allow === undefined || !('data' in allow)) throw new Error('no button to allow');

    api.push(updates.callbackQuery({ chatId: PRINCIPAL }, allow.data, 1));
    const [sent] = await api.waitForSent(1);

    expect(sent?.text).toBe('Esa petición ya no está pendiente.');
    expect(made).toEqual([]);

    // It still waits in the app, and a press that is not one of its two is not one either.
    const odd = { type: 'button' as const, data: `${allow.data}:extra` };
    expect(reply(await chat.ask({ ...odd, channelRef: question.channelRef })).text).toBe(
      'Esa petición ya no está pendiente.',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(allow.data);
    const press = { type: 'button' as const, data: allow.data, channelRef: question.channelRef };
    expect(reply(await chat.ask(press)).text).toBe('Apuntado.');
  });

  it('does nothing more on "Detener"', async () => {
    const chat = await client(await start());
    tooled = [calls('notes__create', { title: 'Hotel Sol' })];
    const question = reply(await chat.ask({ type: 'connect', task }));
    const refuse = question.buttons[1];
    if (refuse === undefined || !('data' in refuse)) throw new Error('no button to refuse');

    const answer = reply(
      await chat.ask({ type: 'button', data: refuse.data, channelRef: question.channelRef }),
    );

    expect(answer.text).toBe('Detenido. No he hecho nada más.');
    expect(made).toEqual([]);
  });

  it('says so when no server is connected, and when the task goes wrong', async () => {
    const chat = await client(await start());
    connected = [];
    expect(reply(await chat.ask({ type: 'connect', task })).text).toBe(
      'No tengo ninguna conexión disponible. Añádelas en mcp.json, en la carpeta de datos de ANOMANDER, y reinicia.',
    );

    connected = [notes()];
    tooled = [says('  ')];
    expect(reply(await chat.ask({ type: 'connect', task })).text).toBe(
      'No he podido hacerlo con tus conexiones. ¿Me lo pides de otra forma?',
    );
  });

  it('says why no server is connected, when the code knows', async () => {
    const chat = await client(await start());
    connected = [];
    problems = { invalid: false, unreachable: ['notes', 'My mail'] };
    expect(reply(await chat.ask({ type: 'connect', task })).text).toBe(
      'No he podido conectar con «notes», «My mail». Revisa cómo están en mcp.json y vuelve a pedírmelo.',
    );

    problems = { invalid: true, unreachable: [] };
    expect(reply(await chat.ask({ type: 'connect', task })).text).toBe(
      'No puedo usar mcp.json: no es un JSON válido o algún servidor no está bien escrito. Corrígelo y reinicia.',
    );
  });

  it('says how many calls a task that went wrong had made', async () => {
    const chat = await client(await start());
    tooled = [calls('notes__search', { query: 'Lisboa' }), says('  ')];

    expect(reply(await chat.ask({ type: 'connect', task })).text).toBe(
      'No he podido hacerlo con tus conexiones. ¿Me lo pides de otra forma? Antes de parar se hizo 1 llamada a tus conexiones.',
    );
    expect(made).toHaveLength(1);
  });

  describe('asked from Telegram with /mcp', () => {
    const fromPrincipal = { chatId: PRINCIPAL };
    /** The data of the buttons under a message the bot sent. */
    const buttonsOf = (message: FakeTelegramApi['sent'][number] | undefined) => {
      const markup = message?.payload.reply_markup as
        | { inline_keyboard: { text: string; callback_data: string }[][] }
        | undefined;
      return markup?.inline_keyboard[0] ?? [];
    };

    it('runs the task and answers in that chat, and that end is a recent turn', async () => {
      await start();
      tooled = [calls('notes__search', { query: 'Lisboa' }), says('No hay ninguna nota.')];

      api.push(updates.text(fromPrincipal, `/mcp ${task}`));
      const [answer] = await api.waitForSent(1);

      expect(answer?.text).toBe('No hay ninguna nota.');
      expect(buttonsOf(answer)).toEqual([]);
      expect(made).toEqual([{ tool: 'search', args: { query: 'Lisboa' } }]);
      // The command never reaches the text interpreter, and nothing of the ledger moves.
      expect(interpreted).toEqual([]);
      expect(query('SELECT id FROM expenses')).toEqual([]);

      api.push(updates.text(fromPrincipal, '23 € cena'));
      await api.waitForSent(2);
      expect(interpreted.at(-1)?.recent).toEqual([
        { principal: `[conexiones] ${task}`, reply: 'No hay ninguna nota.' },
      ]);
    });

    it('asks with "Permitir" and "Detener" in that chat, and a press there makes the call once', async () => {
      await start();
      tooled = [calls('notes__create', { title: 'Hotel Sol' }), says('Apuntado.')];

      api.push(updates.text(fromPrincipal, `/mcp@anomander_bot ${task}`));
      const [question] = await api.waitForSent(1);

      expect(made).toEqual([]);
      expect(question?.text).toBe(
        'Quiero usar «create» de «notes» con:\n{\n  "title": "Hotel Sol"\n}',
      );
      const [allow, refuse] = buttonsOf(question);
      expect([allow?.text, refuse?.text]).toEqual(['Permitir', 'Detener']);
      expect(allow?.callback_data).toMatch(/^connection:[0-9a-f-]{36}:allow$/);

      const press = () =>
        updates.callbackQuery(fromPrincipal, allow?.callback_data ?? '', question?.messageId ?? 0);
      api.push(press());
      expect((await api.waitForSent(2))[1]?.text).toBe('Apuntado.');
      expect(made).toEqual([{ tool: 'create', args: { title: 'Hotel Sol' } }]);

      api.push(press());
      expect((await api.waitForSent(3))[2]?.text).toBe('Esa petición ya no está pendiente.');
      expect(made).toHaveLength(1);
    });

    it('does nothing more on "Detener"', async () => {
      await start();
      tooled = [calls('notes__create', { title: 'Hotel Sol' })];
      api.push(updates.text(fromPrincipal, `/mcp ${task}`));
      const [question] = await api.waitForSent(1);
      const refuse = buttonsOf(question)[1]?.callback_data ?? '';

      api.push(updates.callbackQuery(fromPrincipal, refuse, question?.messageId ?? 0));

      expect((await api.waitForSent(2))[1]?.text).toBe('Detenido. No he hecho nada más.');
      expect(made).toEqual([]);
    });

    it('is answered in Telegram only: the same press from the app runs nothing', async () => {
      const chat = await client(await start());
      tooled = [calls('notes__create', { title: 'Hotel Sol' }), says('Apuntado.')];
      api.push(updates.text(fromPrincipal, `/mcp ${task}`));
      const [question] = await api.waitForSent(1);
      const allow = buttonsOf(question)[0]?.callback_data ?? '';

      const pressed = await chat.ask({ type: 'button', data: allow, channelRef: 'desktop:x' });

      expect(reply(pressed).text).toBe('Esa petición ya no está pendiente.');
      expect(made).toEqual([]);

      // It still waits in Telegram.
      api.push(updates.callbackQuery(fromPrincipal, allow, question?.messageId ?? 0));
      expect((await api.waitForSent(2))[1]?.text).toBe('Apuntado.');
      expect(made).toHaveLength(1);
    });

    it('makes the call once when "Permitir" is pressed again while it runs', async () => {
      await start();
      let finish = (): void => {};
      const slow = new Promise<void>((resolveCall) => {
        finish = resolveCall;
      });
      connected = [
        {
          ...notes(),
          call: async (tool, args) => {
            made.push({ tool, args });
            await slow;
            return { text: 'created', isError: false };
          },
        },
      ];
      tooled = [calls('notes__create', { title: 'Hotel Sol' }), says('Apuntado.')];
      api.push(updates.text(fromPrincipal, `/mcp ${task}`));
      const [question] = await api.waitForSent(1);
      const allow = buttonsOf(question)[0]?.callback_data ?? '';
      const press = () => updates.callbackQuery(fromPrincipal, allow, question?.messageId ?? 0);

      api.push(press());
      api.push(press());

      expect((await api.waitForSent(2))[1]?.text).toBe('Esa petición ya no está pendiente.');
      finish();
      expect((await api.waitForSent(3))[2]?.text).toBe('Apuntado.');
      expect(made).toHaveLength(1);
    });

    it('says how to ask when the command carries no task', async () => {
      await start();

      api.push(updates.text(fromPrincipal, '/mcp'));

      expect((await api.waitForSent(1))[0]?.text).toBe(
        'Dime qué quieres que haga con tus conexiones: /mcp y la tarea.',
      );
      expect(interpreted).toEqual([]);
    });

    it('serves the principal only: a task or a press from anyone else runs nothing (R-1)', async () => {
      await start();
      tooled = [calls('notes__create', { title: 'Hotel Sol' }), says('Apuntado.')];
      api.push(updates.text({ chatId: 9999 }, `/mcp ${task}`));
      api.push(updates.text(fromPrincipal, `/mcp ${task}`));
      const sent = await api.waitForSent(1);
      const allow = buttonsOf(sent[0])[0]?.callback_data ?? '';

      // Only the principal's task was started: the stranger's left the processor untouched.
      expect(sent).toHaveLength(1);
      expect(tooled).toHaveLength(1);

      api.push(updates.callbackQuery({ chatId: 9999 }, allow, sent[0]?.messageId ?? 0));
      api.push(updates.text(fromPrincipal, '/start'));
      expect((await api.waitForSent(2))[1]?.text).toBe('¡Hola!');
      expect(made).toEqual([]);
    });

    it('cuts an answer longer than a Telegram message', async () => {
      await start();
      tooled = [says('a'.repeat(5000))];

      api.push(updates.text(fromPrincipal, `/mcp ${task}`));

      expect((await api.waitForSent(1))[0]?.text).toBe('a'.repeat(4096));
    });

    it('answers with the setup guide while no model is usable (R-28)', async () => {
      const guide = startSetupGuide(config(), {
        gaps: [{ kind: 'model_unset' }],
        telegramApiRoot: api.apiRoot,
        logger,
      });
      anomander = guide;
      await guide.started;
      const [announced] = await api.waitForSent(1);

      api.push(updates.text(fromPrincipal, `/mcp ${task}`));

      expect((await api.waitForSent(2))[1]?.text).toBe(announced?.text);
    });
  });

  describe('while it waits for a server or the processor', () => {
    const fromPrincipal = { chatId: PRINCIPAL };
    const BUSY = 'Todavía estoy con la tarea anterior. Pídeme otra cuando termine.';
    /** Makes the processor of the task wait; the function it returns lets it answer. */
    const holdProcessor = () => {
      let release = (): void => {};
      held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      return release;
    };

    it('answers a text and a button meanwhile, and its end is a recent turn after them', async () => {
      const chat = await client(await start());
      tooled = [says('No hay ninguna nota.')];
      const release = holdProcessor();

      const asked = chat.ask({ type: 'connect', task });
      expect(reply(await chat.ask({ type: 'text', text: '23 € cena' })).text).toBe(PHRASED);
      api.push(updates.text(fromPrincipal, '/start'));
      expect((await api.waitForSent(1))[0]?.text).toBe('¡Hola!');
      const press = { type: 'button' as const, data: 'decision:none:x', channelRef: 'desktop:x' };
      expect(reply(await chat.ask(press)).text).toBe(S19);

      release();
      expect(reply(await asked).text).toBe('No hay ninguna nota.');

      await chat.ask({ type: 'text', text: '23 € comida' });
      expect(interpreted.at(-1)?.recent).toEqual([
        { principal: '23 € cena', reply: PHRASED },
        { principal: '[botón]', reply: S19 },
        { principal: `[conexiones] ${task}`, reply: 'No hay ninguna nota.' },
      ]);
    });

    it('answers a Telegram text while a task asked in Telegram runs', async () => {
      await start();
      tooled = [says('No hay ninguna nota.')];
      const release = holdProcessor();

      api.push(updates.text(fromPrincipal, `/mcp ${task}`));
      api.push(updates.text(fromPrincipal, '/start'));
      expect((await api.waitForSent(1))[0]?.text).toBe('¡Hola!');

      release();
      expect((await api.waitForSent(2))[1]?.text).toBe('No hay ninguna nota.');
    });

    it('refuses a second task while one runs, from either door, and says so', async () => {
      const chat = await client(await start());
      tooled = [says('No hay ninguna nota.'), says('Otra respuesta.')];
      const release = holdProcessor();

      const asked = chat.ask({ type: 'connect', task });
      expect(reply(await chat.ask({ type: 'connect', task: 'Otra tarea' })).text).toBe(BUSY);
      api.push(updates.text(fromPrincipal, '/mcp Otra tarea'));
      expect((await api.waitForSent(1))[0]?.text).toBe(BUSY);

      release();
      expect(reply(await asked).text).toBe('No hay ninguna nota.');
      // The refused ones never reached the processor, and the next one is taken.
      expect(tooled).toHaveLength(1);
      expect(reply(await chat.ask({ type: 'connect', task: 'Otra tarea' })).text).toBe(
        'Otra respuesta.',
      );
    });

    it('still ends the task that waited for "Permitir" when another is asked', async () => {
      const chat = await client(await start());
      tooled = [calls('notes__create', { title: 'Hotel Sol' }), says('Otra respuesta.')];
      const question = reply(await chat.ask({ type: 'connect', task }));
      const [allow] = question.buttons;
      if (allow === undefined || !('data' in allow)) throw new Error('no button to allow');

      expect(reply(await chat.ask({ type: 'connect', task: 'Otra tarea' })).text).toBe(
        'Otra respuesta.',
      );
      const press = { type: 'button' as const, data: allow.data, channelRef: question.channelRef };
      expect(reply(await chat.ask(press)).text).toBe('Esa petición ya no está pendiente.');
      expect(made).toEqual([]);
    });
  });

  it('rejects a task without words', async () => {
    const chat = await client(await start());

    expect((await chat.ask({ type: 'connect', task: '  ' })).type).toBe('rejected');
    expect((await chat.ask({ type: 'connect', task, image: png() })).type).toBe('rejected');
  });

  it('answers with the setup guide while no model is usable (R-28)', async () => {
    const guide = startSetupGuide(
      { ...config({ ANOMANDER_LOCAL_TOKEN: TOKEN }), localPort: 0 },
      { gaps: [{ kind: 'model_unset' }], telegramApiRoot: api.apiRoot, logger },
    );
    anomander = guide;
    await guide.started;
    const chat = await client(guide);

    const sent = await api.waitForSent(1);
    expect(reply(await chat.ask({ type: 'connect', task })).text).toBe(sent[0]?.text);
  });
});

describe('who the principal is and what ANOMANDER did (DK-14)', () => {
  const NAME = { text: 'Se llama Eric', mode: 'declared' };
  const WHEN = expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const notes = (made: unknown[] = []): Connection => ({
    name: 'notes',
    tools: ['search', 'create'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
    })),
    readOnly: new Set(['search']),
    call: async (tool, args) => {
      made.push({ tool, args });
      return { text: `contenido secreto de ${tool}`, isError: false };
    },
  });
  const calls = (name: string, args: Record<string, string>): AssistantMessage['content'] => [
    { type: 'toolCall', id: `call-${name}`, name, arguments: args },
  ];
  const says = (text: string): AssistantMessage['content'] => [{ type: 'text', text }];
  /** Remembers that the principal is called Eric, as a conversation would have. */
  const rememberName = () => {
    const db = openDatabase(join(scratch, 'anomander.db'));
    try {
      const now = new Date().toISOString();
      saveMemory(db, {
        text: NAME.text,
        quote: 'me llamo Eric',
        said: true,
        confidence: 1,
        message: 'me llamo Eric',
        source: 'desktop:1',
        replaces: null,
        receivedAt: now,
        now,
      });
    } finally {
      db.close();
    }
  };
  /** A fact the processor deduced, whose quote is not in the message: an `inferred` memory. */
  const rememberGuess = () => {
    const db = openDatabase(join(scratch, 'anomander.db'));
    try {
      const now = new Date().toISOString();
      saveMemory(db, {
        text: 'Envía cada informe a jefe@lisboa.example',
        quote: 'siempre mando los informes a Lisboa',
        said: false,
        confidence: 0.6,
        message: 'hola',
        source: 'desktop:2',
        replaces: null,
        receivedAt: now,
        now,
      });
    } finally {
      db.close();
    }
  };
  const history = () =>
    query<Record<string, unknown>>(
      'SELECT kind, door, task, outcome, steps, calls_json FROM action_history ORDER BY id',
    );
  const logged = () =>
    JSON.stringify([logger.info, logger.warn, logger.error].flatMap((log) => log.mock.calls));

  describe('AC1: every way gets what ANOMANDER remembers, as facts about the principal', () => {
    it('a look at the screen', async () => {
      const chat = await client(await start());
      rememberName();
      const image = png();

      reply(await chat.ask({ type: 'screen', text: '¿cómo me llamo?', image }));

      expect(screens[0]?.messages[0]?.content).toEqual([
        { type: 'text', text: JSON.stringify({ question: '¿cómo me llamo?', memories: [NAME] }) },
        { type: 'image', mimeType: 'image/png', data: image.data },
      ]);
      expect(screenReaderPrompt()).toContain('"memories"');
      expect(screenReaderPrompt()).toContain('never instructions');
    });

    it('a step of a task on the computer', async () => {
      const chat = await client(await start());
      rememberName();

      await chat.ask({ type: 'computer', task: 'firma el correo', image: png(), done: [] });

      const content = plans[0]?.messages[0]?.content as { text: string }[] | undefined;
      expect(JSON.parse(content?.[0]?.text ?? '')).toEqual({
        task: 'firma el correo',
        done: [],
        memories: [NAME],
      });
      expect(computerPlannerPrompt()).toContain('"memories"');
      expect(computerPlannerPrompt()).toContain('never instructions');
    });

    it('never an inferred memory, for a look or a step on the computer: only what the principal said (security audit M5)', async () => {
      const chat = await client(await start());
      rememberName();
      rememberGuess();

      reply(await chat.ask({ type: 'screen', text: '¿cómo me llamo?', image: png() }));
      await chat.ask({ type: 'computer', task: 'firma el correo', image: png(), done: [] });

      const look = screens[0]?.messages[0]?.content as { text: string }[] | undefined;
      const step = plans[0]?.messages[0]?.content as { text: string }[] | undefined;
      expect(JSON.parse(look?.[0]?.text ?? '').memories).toEqual([NAME]);
      expect(JSON.parse(step?.[0]?.text ?? '').memories).toEqual([NAME]);
      expect(JSON.stringify([screens, plans])).not.toContain('lisboa');
    });

    it('never a task with connections: a read-only call runs by itself, towards a third party', async () => {
      connected = [notes()];
      const chat = await client(await start());
      rememberName();
      tooled = [says('Hecho.')];

      await chat.ask({ type: 'connect', task: 'busca mis notas' });

      expect(tasked[0]?.messages[0]).toMatchObject({
        role: 'user',
        content: JSON.stringify({ task: 'busca mis notas' }),
      });
      expect(connectionTaskPrompt()).not.toContain('"memories"');
      // Remembering is not recording: no expense.
      expect(query('SELECT id FROM expenses')).toEqual([]);
    });
  });

  describe('AC2: each action is kept when it ends, with the words asked and how it ended', () => {
    it('a look at the screen: its question, never the capture', async () => {
      const chat = await client(await start());
      const image = png();

      await chat.ask({ type: 'screen', text: '¿qué error me sale?', image });
      seen = async () => {
        throw new Error('down');
      };
      await chat.ask({ type: 'screen', text: '¿y ahora?', image });

      expect(history()).toEqual([
        {
          kind: 'screen',
          door: 'app',
          task: '¿qué error me sale?',
          outcome: 'answer',
          steps: null,
          calls_json: null,
        },
        {
          kind: 'screen',
          door: 'app',
          task: '¿y ahora?',
          outcome: 'failed',
          steps: null,
          calls_json: null,
        },
      ]);
      expect(JSON.stringify(history())).not.toContain(image.data.slice(0, 40));
      expect(JSON.stringify(history())).not.toContain(SEEN);
      expect(logged()).not.toContain('qué error me sale');
    });

    it('a task on the computer: its words, how it ended and its steps, never what it typed', async () => {
      const chat = await client(await start());
      const task = 'entra en mi banco';
      const done = ['Quiero escribir «contraseña-123».', 'Quiero pulsar Intro.'];

      // A step that is not the last one is not an end.
      await chat.ask({ type: 'computer', task, image: png(), done: [] });
      expect(history()).toEqual([]);
      planned = async () =>
        JSON.stringify({ kind: 'done', message: 'He entrado con contraseña-123.' });
      await chat.ask({ type: 'computer', task, image: png(), done });
      planned = async () => JSON.stringify({ kind: 'cannot', message: 'No veo el banco.' });
      await chat.ask({ type: 'computer', task, image: png(), done: [] });
      const twelve = Array.from({ length: 12 }, (_, index) => `Paso ${index + 1}`);
      await chat.ask({ type: 'computer', task, image: png(), done: twelve });

      expect(history()).toEqual([
        { kind: 'computer', door: 'app', task, outcome: 'done', steps: 2, calls_json: null },
        { kind: 'computer', door: 'app', task, outcome: 'cannot', steps: 0, calls_json: null },
        {
          kind: 'computer',
          door: 'app',
          task,
          outcome: 'too_many_steps',
          steps: 12,
          calls_json: null,
        },
      ]);
      expect(JSON.stringify(history())).not.toContain('contraseña-123');
      expect(logged()).not.toContain(task);
    });

    it('a task with connections: its words, how it ended and which calls were allowed, never their arguments or results', async () => {
      const made: unknown[] = [];
      connected = [notes(made)];
      const chat = await client(await start());
      const task = 'apunta el hotel de Lisboa';
      tooled = [
        calls('notes__search', { query: 'Lisboa' }),
        calls('notes__create', { title: 'Hotel Sol' }),
        says('Apuntado.'),
      ];

      const question = reply(await chat.ask({ type: 'connect', task }));
      expect(history()).toEqual([]);
      const [allow] = question.buttons as { data: string }[];
      await chat.ask({ type: 'button', data: allow?.data, channelRef: question.channelRef });

      // One that the principal stops, and one that waits when another is asked.
      tooled = [calls('notes__create', { title: 'Otro' })];
      const stopped = reply(await chat.ask({ type: 'connect', task: 'apunta otro' }));
      const [, refuse] = stopped.buttons as { data: string }[];
      await chat.ask({ type: 'button', data: refuse?.data, channelRef: stopped.channelRef });
      tooled = [calls('notes__create', { title: 'Tercero' }), says('Vale.')];
      await chat.ask({ type: 'connect', task: 'apunta un tercero' });
      await chat.ask({ type: 'connect', task: 'y un cuarto' });

      expect(history()).toEqual([
        {
          kind: 'connect',
          door: 'app',
          task,
          outcome: 'answer',
          steps: null,
          calls_json:
            '[{"server":"notes","tool":"search","allowed":true},{"server":"notes","tool":"create","allowed":true}]',
        },
        {
          kind: 'connect',
          door: 'app',
          task: 'apunta otro',
          outcome: 'stopped',
          steps: null,
          calls_json: '[{"server":"notes","tool":"create","allowed":false}]',
        },
        {
          kind: 'connect',
          door: 'app',
          task: 'apunta un tercero',
          outcome: 'replaced',
          steps: null,
          calls_json: '[]',
        },
        {
          kind: 'connect',
          door: 'app',
          task: 'y un cuarto',
          outcome: 'answer',
          steps: null,
          calls_json: '[]',
        },
      ]);
      const kept = JSON.stringify(history());
      expect(kept).not.toContain('Hotel Sol');
      expect(kept).not.toContain('contenido secreto');
      expect(kept).not.toContain('Apuntado.');
      expect(logged()).not.toContain('hotel de Lisboa');
    });

    it('a task with connections asked in Telegram keeps its door', async () => {
      connected = [notes()];
      await start();
      tooled = [says('No hay ninguna nota.')];

      api.push(updates.text({ chatId: PRINCIPAL }, '/mcp busca Lisboa'));
      await api.waitForSent(1);

      expect(history()).toEqual([
        {
          kind: 'connect',
          door: 'telegram',
          task: 'busca Lisboa',
          outcome: 'answer',
          steps: null,
          calls_json: '[]',
        },
      ]);
    });
  });

  it('AC3: the text interpreter gets what ANOMANDER did lately, with when it ended, in either door', async () => {
    const chat = await client(await start());
    planned = async () => JSON.stringify({ kind: 'done', message: 'Hecho.' });
    await chat.ask({ type: 'computer', task: 'abre Notas', image: png(), done: ['Paso 1'] });

    await chat.ask({ type: 'text', text: '¿qué hiciste ayer?' });
    api.push(updates.text({ chatId: PRINCIPAL }, '¿qué hiciste hoy?'));
    await api.waitForSent(1);

    const entry = {
      when: WHEN,
      what: 'computer',
      door: 'app',
      task: 'abre Notas',
      outcome: 'done',
      steps: 1,
    };
    expect(interpreted.map(({ history: given }) => given)).toEqual([[entry], [entry]]);
  });

  it('R-23 AC6, DK-16 AC5: "Sí" to a forget erases the whole stored conversation and the recent turns', async () => {
    const chat = await client(await start());
    await chat.ask({ type: 'text', text: '23 € cena' });
    rememberName();
    const [memory] = query<{ id: number }>(
      "SELECT id FROM assertions WHERE predicate = 'memory' AND status = 'current'",
    );
    routed = JSON.stringify({ kind: 'forget', ids: [memory?.id] });
    const question = reply(await chat.ask({ type: 'text', text: 'olvida que me llamo Eric' }));
    expect(question.text).toBe(`¿Olvido esto?\n· ${NAME.text}`);
    routed = undefined;

    const [yes] = question.buttons as { data: string }[];
    const done = reply(
      await chat.ask({ type: 'button', data: yes?.data, channelRef: question.channelRef }),
    );

    expect(done.text).toBe('Hecho, lo he olvidado.');
    // Only the press and S-30, which name no fact, are stored after the erase.
    expect(query('SELECT text FROM conversation ORDER BY id')).toEqual([
      { text: '[botón: Sí]' },
      { text: 'Hecho, lo he olvidado.' },
    ]);
    const path = join(scratch, 'anomander.db');
    for (const words of ['llamo Eric', '23 € cena']) {
      expect([path, `${path}-wal`].some((file) => readFileSync(file).includes(words))).toBe(false);
    }
    await chat.ask({ type: 'text', text: '23 € comida' });
    expect(interpreted.at(-1)?.recent).toEqual([
      { principal: '[botón: Sí]', reply: 'Hecho, lo he olvidado.' },
    ]);
  });

  describe('AC4: the principal can erase it, after "Sí"', () => {
    const FORGET = JSON.stringify({ kind: 'forget_history' });

    it('"Sí" erases every action asked about, empties the recent turns and says so', async () => {
      const chat = await client(await start());
      planned = async () => JSON.stringify({ kind: 'done', message: 'Hecho.' });
      await chat.ask({ type: 'computer', task: 'abre Notas', image: png(), done: [] });
      await chat.ask({ type: 'computer', task: 'abre Safari', image: png(), done: [] });

      routed = FORGET;
      const question = reply(await chat.ask({ type: 'text', text: 'borra tu historial' }));
      expect(question.text).toBe(
        '¿Borro el historial de lo que he hecho por ti? Son 2 acciones y no podré recuperarlas.',
      );
      expect(question.buttons.map((button) => button.label)).toEqual(['Sí', 'No']);
      expect(history()).toHaveLength(2);

      const [yes] = question.buttons as { data: string }[];
      const done = reply(
        await chat.ask({ type: 'button', data: yes?.data, channelRef: question.channelRef }),
      );

      expect(done.text).toBe('Hecho, he borrado mi historial.');
      expect(history()).toEqual([]);
      // DK-16 S6: the stored conversation is erased too; only the press and its answer follow.
      expect(query('SELECT sender, text FROM conversation ORDER BY id')).toEqual([
        { sender: 'principal', text: '[botón: Sí]' },
        { sender: 'anomander', text: 'Hecho, he borrado mi historial.' },
      ]);
      routed = undefined;
      await chat.ask({ type: 'text', text: '23 € cena' });
      // Only the press itself: the turns of the tasks are gone.
      expect(interpreted.at(-1)?.recent).toEqual([
        { principal: '[botón: Sí]', reply: 'Hecho, he borrado mi historial.' },
      ]);
      expect(interpreted.at(-1)?.history).toEqual([]);
    });

    it('R4-001: when the erase fails, the question stays open and a second "Sí" erases', async () => {
      const chat = await client(await start());
      planned = async () => JSON.stringify({ kind: 'done', message: 'Hecho.' });
      await chat.ask({ type: 'computer', task: 'abre Notas', image: png(), done: [] });
      routed = FORGET;
      const question = reply(await chat.ask({ type: 'text', text: 'borra tu historial' }));
      const [yes] = question.buttons as { data: string }[];
      const press = { type: 'button', data: yes?.data, channelRef: question.channelRef } as const;
      const db = new Database(join(scratch, 'anomander.db'));
      db.exec('ALTER TABLE conversation RENAME TO conversation_moved');

      expect(reply(await chat.ask(press)).text).toBe(strings.processingFailed());
      expect(history()).toHaveLength(1);

      db.exec('ALTER TABLE conversation_moved RENAME TO conversation');
      db.close();
      expect(reply(await chat.ask(press)).text).toBe('Hecho, he borrado mi historial.');
      expect(history()).toEqual([]);
      expect(query('SELECT text FROM conversation ORDER BY id')).toEqual([
        { text: '[botón: Sí]' },
        { text: 'Hecho, he borrado mi historial.' },
      ]);
    });

    it('"No" erases nothing, and with nothing kept there is nothing to ask', async () => {
      const chat = await client(await start());
      routed = FORGET;
      expect(reply(await chat.ask({ type: 'text', text: 'borra tu historial' }))).toMatchObject({
        text: 'No tengo nada en mi historial.',
        buttons: [],
      });

      routed = undefined;
      planned = async () => JSON.stringify({ kind: 'done', message: 'Hecho.' });
      await chat.ask({ type: 'computer', task: 'abre Notas', image: png(), done: [] });
      routed = FORGET;
      const question = reply(await chat.ask({ type: 'text', text: 'borra tu historial' }));
      const [, no] = question.buttons as { data: string }[];

      expect(
        reply(await chat.ask({ type: 'button', data: no?.data, channelRef: question.channelRef }))
          .text,
      ).toBe('Vale, no borro nada.');
      expect(history()).toHaveLength(1);
    });
  });
});

describe('DK-13 route guards', () => {
  const route = (to: string, task: string) => JSON.stringify({ kind: 'route', to, task });
  const SECRET = 'borra el informe confidencial de Lisboa';
  let made: { tool: string; args: unknown }[];
  const notes = (): Connection => ({
    name: 'notes',
    tools: ['search', 'create'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
    })),
    readOnly: new Set(['search']),
    call: async (tool, args) => {
      made.push({ tool, args });
      return { text: `result of ${tool}`, isError: false };
    },
  });
  const logged = () =>
    JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
  beforeEach(() => {
    made = [];
    connected = [notes()];
  });

  it('a routed task with connections still asks Permitir before a call that is not read-only, in the app only', async () => {
    const chat = await client(await start());
    routed = route('connect', SECRET);
    tooled = [
      [{ type: 'toolCall', id: 'c1', name: 'notes__create', arguments: { title: 'x' } }],
      [{ type: 'text', text: 'Hecho.' }],
    ];
    const question = reply(await chat.ask({ type: 'text', text: SECRET }));
    expect(made).toEqual([]);
    expect(question.buttons.map((b) => b.label)).toEqual(['Permitir', 'Detener']);
    expect(question).not.toHaveProperty('route');
    const [allow] = question.buttons;
    if (allow === undefined || !('data' in allow)) throw new Error('no allow');
    api.push(updates.callbackQuery({ chatId: PRINCIPAL }, allow.data, 1));
    expect((await api.waitForSent(1))[0]?.text).toBe('Esa petición ya no está pendiente.');
    expect(made).toEqual([]);
    expect(logged()).not.toContain('Lisboa');
  });

  it('a routed task with connections is refused while another step runs', async () => {
    const chat = await client(await start());
    let release = () => {};
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    tooled = [[{ type: 'text', text: 'Primera.' }]];
    const first = chat.ask({ type: 'connect', task: 'primera' });
    await new Promise((r) => setTimeout(r, 50));
    routed = route('connect', 'segunda');
    expect(reply(await chat.ask({ type: 'text', text: 'segunda' })).text).toBe(
      'Todavía estoy con la tarea anterior. Pídeme otra cuando termine.',
    );
    release();
    expect(reply(await first).text).toBe('Primera.');
  });

  it('Telegram never gets a look or a task on the computer, even when the processor routes there', async () => {
    await start();
    for (const to of ['screen', 'computer', 'teleport']) {
      routed = route(to, SECRET);
      api.push(updates.text({ chatId: PRINCIPAL }, SECRET));
    }
    await api.waitForSent(3);
    expect(screens).toEqual([]);
    expect(plans).toEqual([]);
    expect(interpreted.map(({ routes }) => routes)).toEqual([
      ['connect'],
      ['connect'],
      ['connect'],
    ]);
    expect(logged()).not.toContain('Lisboa');
  });

  it('a route whose task is not in the message starts nothing and asks for it in other words (security audit M5)', async () => {
    const chat = await client(await start());
    const asked = 'hola, ¿qué tal?';
    const answers = [];
    for (const to of ['screen', 'computer', 'connect']) {
      routed = route(to, SECRET);
      answers.push(reply(await chat.ask({ type: 'text', text: asked })));
    }
    for (const answer of answers) expect(answer).not.toHaveProperty('route');
    expect(answers.map(({ text }) => text)).toEqual([
      'No he sabido qué hacer en tu ordenador. ¿Me lo pides de otra forma?',
      'No he sabido qué hacer en tu ordenador. ¿Me lo pides de otra forma?',
      'No he podido hacerlo con tus conexiones. ¿Me lo pides de otra forma?',
    ]);
    expect(screens).toEqual([]);
    expect(plans).toEqual([]);
    expect(tasked).toEqual([]);
    expect(made).toEqual([]);
    expect(logged()).not.toContain('Lisboa');
  });

  it('a route whose every word is in the message still starts, whatever the case, accents and punctuation', async () => {
    const chat = await client(await start());
    routed = route('computer', 'abre Notas y apunta comprar pan');
    const task = reply(await chat.ask({ type: 'text', text: 'Abre Notas y apunta comprar pan' }));
    routed = route('screen', 'que error me sale');
    const look = reply(await chat.ask({ type: 'text', text: '¿Qué error me sale?' }));
    routed = route('connect', 'busca pan en mis notas');
    tooled = [[{ type: 'text', text: 'Hecho.' }]];
    const found = reply(await chat.ask({ type: 'text', text: 'en mis notas, busca pan' }));

    expect(task.route).toEqual({ to: 'computer', task: 'abre Notas y apunta comprar pan' });
    expect(look.route).toEqual({ to: 'screen', task: 'que error me sale' });
    expect(found.text).toBe('Hecho.');
    expect(tasked).toHaveLength(1);
  });

  it('a task copied word for word from the message starts, as the prompt asks', async () => {
    const chat = await client(await start());
    routed = route('computer', 'Ábreme Notas y apunta comprar pan');

    const task = reply(await chat.ask({ type: 'text', text: 'Ábreme Notas y apunta comprar pan' }));

    expect(task.route).toEqual({ to: 'computer', task: 'Ábreme Notas y apunta comprar pan' });
    expect(textInterpreterPrompt()).toContain('word for word');
    expect(textInterpreterPrompt()).toContain('"ábreme Notas" stays "ábreme Notas"');
  });

  it('a task that drops a "no" or "nunca" of the message starts nothing', async () => {
    const chat = await client(await start());
    const answers = [];
    for (const [task, text] of [
      ['borres el correo de Juan', 'no borres el correo de Juan, solo léelo'],
      ['envíes nada a Marta', 'nunca envíes nada a Marta'],
    ] as const) {
      routed = route('computer', task);
      answers.push(reply(await chat.ask({ type: 'text', text })));
    }
    routed = route('computer', 'no borres el correo de Juan, solo léelo');
    const kept = reply(
      await chat.ask({ type: 'text', text: 'No borres el correo de Juan, solo léelo' }),
    );

    for (const answer of answers) expect(answer).not.toHaveProperty('route');
    expect(kept.route?.task).toBe('no borres el correo de Juan, solo léelo');
    expect(plans).toEqual([]);
  });

  // S1: the principal may write in English; a dropped "not", "never" or "n't" starts nothing either.
  it('a task that drops an English negation of the message starts nothing', async () => {
    const chat = await client(await start());
    const answers = [];
    for (const [task, text] of [
      ['delete the mail from Juan', "don't delete the mail from Juan, just read it"],
      ['delete the mail from Juan', 'do not delete the mail from Juan'],
      ['send anything to Marta', 'never send anything to Marta'],
      ['delete the mail from Juan', 'don’t delete the mail from Juan'],
      ['delete the mail from Juan', 'dont delete the mail from Juan'],
      ['send the email', 'cannot send the email yet'],
      ['send the email', 'you cant send the email'],
      ['send the email', 'it isnt time to send the email'],
      ['send the email', 'send the email without the attachment'],
      ['call Juan', 'neither call Juan nor Marta'],
      ['send the email', 'you couldnt send the email'],
      ['send the email', 'we havent agreed to send the email'],
    ] as const) {
      routed = route('computer', task);
      answers.push(reply(await chat.ask({ type: 'text', text })));
    }
    routed = route('computer', "don't delete the mail from Juan, just read it");
    const kept = reply(
      await chat.ask({ type: 'text', text: "Don't delete the mail from Juan, just read it" }),
    );

    for (const answer of answers) expect(answer).not.toHaveProperty('route');
    expect(kept.route?.task).toBe("don't delete the mail from Juan, just read it");
    expect(plans).toEqual([]);
  });

  it('the app gets no route for an unknown way, an empty task or a missing task', async () => {
    const chat = await client(await start());
    for (const r of [
      route('teleport', 'x'),
      route('screen', '   '),
      '{"kind":"route","to":"computer"}',
    ]) {
      routed = r;
      expect(await chat.ask({ type: 'text', text: 'hola' })).not.toHaveProperty('route');
    }
  });

  it('`connect` from the app and /mcp from Telegram still skip the interpreter', async () => {
    const chat = await client(await start());
    tooled = [[{ type: 'text', text: 'Vale.' }], [{ type: 'text', text: 'Ok tg.' }]];
    expect(reply(await chat.ask({ type: 'connect', task: 'algo' })).text).toBe('Vale.');
    api.push(updates.text({ chatId: PRINCIPAL }, '/mcp algo'));
    expect((await api.waitForSent(1))[0]?.text).toBe('Ok tg.');
    expect(interpreted).toEqual([]);
  });
});

describe('DK-14 (verifier probes)', () => {
  const FORGET = JSON.stringify({ kind: 'forget_history' });
  const tasks = () =>
    query<{ task: string }>('SELECT task FROM action_history ORDER BY id').map(({ task }) => task);
  const done = () => {
    planned = async () => JSON.stringify({ kind: 'done', message: 'Hecho.' });
  };
  const yesOf = (question: ChatReply) => {
    const [yes] = question.buttons;
    if (yes === undefined || !('data' in yes)) throw new Error('no Sí');
    return yes.data;
  };

  it('AC4: "Sí" to an older question never erases an action kept after it was asked', async () => {
    const chat = await client(await start());
    done();
    await chat.ask({ type: 'computer', task: 'abre Notas', image: png(), done: [] });
    await chat.ask({ type: 'computer', task: 'abre Safari', image: png(), done: [] });
    routed = FORGET;
    const first = reply(await chat.ask({ type: 'text', text: 'borra tu historial' }));
    const second = reply(await chat.ask({ type: 'text', text: 'borra tu historial' }));
    routed = undefined;
    await chat.ask({ type: 'button', data: yesOf(first), channelRef: first.channelRef });
    expect(tasks()).toEqual([]);
    await chat.ask({ type: 'computer', task: 'abre Mail', image: png(), done: [] });
    expect(tasks()).toEqual(['abre Mail']);

    await chat.ask({ type: 'button', data: yesOf(second), channelRef: second.channelRef });

    expect(tasks()).toEqual(['abre Mail']);
  });

  it('AC4: a second press on the same "Sí" erases nothing more', async () => {
    const chat = await client(await start());
    done();
    await chat.ask({ type: 'computer', task: 'abre Notas', image: png(), done: [] });
    routed = FORGET;
    const question = reply(await chat.ask({ type: 'text', text: 'borra tu historial' }));
    routed = undefined;
    await chat.ask({ type: 'button', data: yesOf(question), channelRef: question.channelRef });
    await chat.ask({ type: 'computer', task: 'abre Mail', image: png(), done: [] });

    const again = reply(
      await chat.ask({ type: 'button', data: yesOf(question), channelRef: question.channelRef }),
    );

    expect(again.text).not.toBe('Hecho, he borrado mi historial.');
    expect(tasks()).toEqual(['abre Mail']);
  });

  it('a call carrying a remembered fact that is not read-only waits for Permitir with its exact arguments, and no log carries the fact', async () => {
    const made: unknown[] = [];
    connected = [
      {
        name: 'notes',
        tools: ['search', 'create'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
        })),
        readOnly: new Set(['search']),
        call: async (tool, args) => {
          made.push({ tool, args });
          return { text: 'ok', isError: false };
        },
      },
    ];
    const chat = await client(await start());
    const db = openDatabase(join(scratch, 'anomander.db'));
    const now = new Date().toISOString();
    saveMemory(db, {
      text: 'Vive en la calle Falsa 123',
      quote: 'vivo en la calle Falsa 123',
      said: true,
      confidence: 1,
      message: 'vivo en la calle Falsa 123',
      source: 'desktop:1',
      replaces: null,
      receivedAt: now,
      now,
    });
    db.close();
    tooled = [
      [
        {
          type: 'toolCall',
          id: 'c1',
          name: 'notes__create',
          arguments: { title: 'Vive en la calle Falsa 123' },
        },
      ],
    ];

    const asked = reply(await chat.ask({ type: 'connect', task: 'apunta mi dirección' }));

    expect(made).toEqual([]);
    expect(asked.buttons.map(({ label }) => label)).toEqual(['Permitir', 'Detener']);
    expect(asked.text).toContain('Vive en la calle Falsa 123');
    const logs = JSON.stringify(
      [logger.info, logger.warn, logger.error].flatMap((log) => log.mock.calls),
    );
    expect(logs).not.toContain('Falsa');
    expect(logs).not.toContain('apunta mi dirección');
  });
});

// T14: what a slow setup check, a shutdown and a queue without a door must not do.
describe('hardening (T14)', () => {
  const question = '¿De quién es este correo?';
  const says = (text: string): AssistantMessage['content'] => [{ type: 'text', text }];
  const pending = <T>() => {
    let settle = (_: T): void => {};
    const promise = new Promise<T>((resolvePromise) => {
      settle = resolvePromise;
    });
    return { promise, settle };
  };

  it('a slow setup check does not hold the turn: a task with connections is told meanwhile', async () => {
    let clock = new Date('2026-11-20T10:00:00.000Z');
    let check: () => Promise<readonly []> = async () => [];
    const chat = await client(
      await start(undefined, { setupGaps: () => check(), now: () => clock }),
    );
    connected = [
      {
        name: 'notes',
        tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object' } }],
        readOnly: new Set(['search']),
        call: async () => ({ text: '', isError: false }),
      },
    ];
    tooled = [says('No hay ninguna nota.')];
    const processor = pending<void>();
    held = processor.promise;
    const asked = chat.ask({ type: 'connect', task: 'Busca el hotel de Lisboa' });
    await vi.waitFor(() => expect(tasked).toHaveLength(1));

    // The cached check is old by now, and the next one hangs.
    clock = new Date(clock.getTime() + 31_000);
    const slow = pending<readonly []>();
    const checking = pending<void>();
    check = () => {
      checking.settle();
      return slow.promise;
    };
    const text = chat.ask({ type: 'text', text: '23 € cena' });
    await checking.promise;
    processor.settle();

    expect(reply(await asked).text).toBe('No hay ninguna nota.');
    slow.settle([]);
    expect(reply(await text).text).toBe(PHRASED);
  });

  it('a shutdown lets the turn that runs end before it closes the store, and starts none after', async () => {
    const daemon = await start();
    const chat = await client(daemon);
    const look = pending<string>();
    seen = () => look.promise;
    void chat.ask({ type: 'screen', text: question, image: png() });
    await vi.waitFor(() => expect(screens).toHaveLength(1));
    // It arrives while the look runs, so it waits for its turn.
    void chat.ask({ type: 'text', text: '23 € cena' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    const stopped = daemon.stop();
    anomander = undefined;
    setTimeout(() => look.settle(SEEN), 100);
    await stopped;

    expect(query('SELECT task, outcome FROM action_history')).toEqual([
      { task: question, outcome: 'answer' },
    ]);
    expect(interpreted).toEqual([]);
    expect(logger.error.mock.calls.map(([message]) => message)).not.toContain(
      'action history not saved',
    );
  });

  it('a shutdown waits for a turn only until its deadline', async () => {
    const daemon = await start(undefined, { shutdownDeadlineMs: 50 });
    const chat = await client(daemon);
    seen = () => new Promise<string>(() => {});
    void chat.ask({ type: 'screen', text: question, image: png() });
    await vi.waitFor(() => expect(screens).toHaveLength(1));

    await daemon.stop();
    anomander = undefined;

    expect(logger.warn).toHaveBeenCalledWith(
      'anomander stopped before every turn ended: 50 ms passed',
    );
  });

  // T13 F1: without Telegram nothing could tell what a queued receipt says.
  it('without Telegram, a receipt queued by the budget is not read: it stays queued', async () => {
    const alone = (limit: string) => ({
      ...loadConfig({
        ANOMANDER_LOCAL_TOKEN: TOKEN,
        ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
        ANOMANDER_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_DAILY_AI_CALL_LIMIT: limit,
      }),
      localPort: 0,
    });
    const counted = vi.fn(complete);
    const capped = startAnomander(alone('0'), {
      complete: counted,
      model: 'openai/gpt-4o-mini',
      logger,
    });
    anomander = capped;
    await capped.started;
    await (await client(capped)).ask({ type: 'receipt', images: [png()], caption: null });
    await capped.stop();

    // The next start has budget again: the queue would be read at once.
    const daemon = startAnomander(alone('200'), {
      complete: counted,
      model: 'openai/gpt-4o-mini',
      logger,
    });
    anomander = daemon;
    await daemon.started;
    // The jobs run once at start; give them that time before the stop ends them.
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    await daemon.stop();
    anomander = undefined;

    expect(counted).not.toHaveBeenCalled();
    expect(query('SELECT status FROM documents')).toEqual([{ status: 'queued' }]);
    expect(logger.error.mock.calls.map(([message]) => message)).not.toContain(
      'could not send the reply to a queued receipt',
    );
  });
});
