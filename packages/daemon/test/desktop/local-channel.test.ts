import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ChatEvent,
  type ChatReply,
  type ChatRequest,
  LOCAL_CHANNEL_PROTOCOL,
} from '@anomander/protocol';
import {
  type FakeTelegramApi,
  pngBytes,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander, startSetupGuide } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { COMPUTER_PLANNER_PROMPT } from '../../src/processor/computer-planner.ts';
import { RECEIPT_READER_PROMPT } from '../../src/processor/receipt-reader.ts';
import { REPLY_PHRASER_PROMPT } from '../../src/processor/reply-phraser.ts';
import { SCREEN_READER_PROMPT } from '../../src/processor/screen-reader.ts';

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
let interpreted: { recent: unknown; message: string }[];
/** The contexts the computer planner received. */
let plans: Context[];
/** What the computer planner answers, as the text of its response. */
let planned: () => Promise<string>;
/** The contexts the screen reader received. */
let screens: Context[];
/** What the screen reader answers; a test replaces it to make the call fail. */
let seen: () => Promise<string>;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };

const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
  if (context.systemPrompt === RECEIPT_READER_PROMPT) {
    return recorded('receipt-reader/lines-mismatch');
  }
  const reply = recorded('text-interpreter/expense-23-space-euro');
  if (context.systemPrompt === COMPUTER_PLANNER_PROMPT) {
    plans.push(context);
    return { ...reply, content: [{ type: 'text', text: await planned() }] };
  }
  if (context.systemPrompt === SCREEN_READER_PROMPT) {
    screens.push(context);
    return { ...reply, content: [{ type: 'text', text: await seen() }] };
  }
  if (context.systemPrompt === REPLY_PHRASER_PROMPT) {
    return { ...reply, content: [{ type: 'text', text: PHRASED }] };
  }
  const [turn] = context.messages;
  if (typeof turn?.content === 'string') interpreted.push(JSON.parse(turn.content));
  return reply;
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
const start = async (env: Record<string, string> = { ANOMANDER_LOCAL_TOKEN: TOKEN }) => {
  anomander = startAnomander(
    { ...config(env), localPort: 0 },
    { complete, model: 'openai/gpt-4o-mini', telegramApiRoot: api.apiRoot, logger },
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
  screens = [];
  plans = [];
  planned = async () => JSON.stringify(CLICK);
  seen = async () => SEEN;
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
    expect(context?.messages[0]?.content).toEqual([
      { type: 'text', text: question },
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
      { type: 'text', text: JSON.stringify({ task, done: ['Paso uno'] }) },
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
