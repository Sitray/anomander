import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ChatConnectionGrant,
  type ChatEvent,
  type ChatReply,
  type ChatRequest,
  LOCAL_CHANNEL_PROTOCOL,
} from '@anomander/protocol';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import type { Connection } from '../../src/connections/connection.ts';
import { connectionTaskPrompt } from '../../src/connections/task.ts';

// DK-24 (docs/desktop-prd.md): "Permitir siempre" on a call of a task with connections, granted
// by the principal and revocable. A real WebSocket client against the local channel of a started
// daemon, and the fake Telegram API, as in `local-channel.test.ts`.
const PRINCIPAL = 4242;
const TOKEN = 'connection-grants-test-token-0123456789ab';
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const BASE: AssistantMessage = JSON.parse(
  readFileSync(resolve(FIXTURES, 'text-interpreter/expense-23-space-euro.json'), 'utf8'),
);
const TASK = 'Apunta en mis notas el hotel de Lisboa';
/** A value of the arguments no log may carry. */
const SECRET_TITLE = 'Hotel Sol de Belém';

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander | undefined;
let sockets: WebSocket[];
let connected: Connection[];
/** What the processor answers to a task with connections, one response per call. */
let tooled: AssistantMessage['content'][];
let made: { server: string; tool: string; args: unknown }[];
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };

const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
  if (context.systemPrompt === connectionTaskPrompt()) {
    return { ...BASE, content: tooled.shift() ?? [] };
  }
  return BASE;
};

type Arguments = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>['arguments'];
const calls = (name: string, args: Arguments): AssistantMessage['content'] => [
  { type: 'toolCall', id: `call-${name}`, name, arguments: args },
];
const says = (text: string): AssistantMessage['content'] => [{ type: 'text', text }];

/** A server the principal connected, as `mcp.json` names it and its command or URL makes it. */
const server = (name: string, identity: string | null = `id-${name}`): Connection => ({
  name,
  ...(identity === null ? {} : { identity }),
  tools: ['search', 'create', 'delete'].map((tool) => ({
    name: tool,
    description: tool,
    inputSchema: { type: 'object' },
  })),
  readOnly: new Set(['search']),
  call: async (tool, args) => {
    made.push({ server: name, tool, args });
    return { text: `result of ${tool}`, isError: false };
  },
});

const start = async (env: Record<string, string> = {}, fromFile = false) => {
  anomander = startAnomander(
    {
      ...loadConfig({
        TELEGRAM_BOT_TOKEN: api.token,
        ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
        ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
        ANOMANDER_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_LOCAL_TOKEN: TOKEN,
        ...env,
      }),
      localPort: 0,
    },
    {
      complete,
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      ...(fromFile ? {} : { connections: async () => connected }),
    },
  );
  await anomander.started;
  return anomander;
};

const stop = async () => {
  for (const socket of sockets) socket.close();
  sockets = [];
  await anomander?.stop();
  anomander = undefined;
};

/** A connected client: `ask` sends a request and resolves with the event that answers it. */
const client = async (daemon: Anomander) => {
  const address = await daemon.localChannel;
  if (address === undefined) throw new Error('the local channel did not start');
  const socket = new WebSocket(`ws://${address.host}:${address.port}`, [
    LOCAL_CHANNEL_PROTOCOL,
    TOKEN,
  ]);
  sockets.push(socket);
  const events: ChatEvent[] = [];
  const waiting = new Set<() => void>();
  socket.addEventListener('message', (message) => {
    events.push(JSON.parse(String(message.data)));
    for (const check of waiting) check();
  });
  await new Promise<void>((opened, failed) => {
    socket.addEventListener('open', () => opened());
    socket.addEventListener('close', () => failed(new Error('closed before it opened')));
  });
  let nextId = 1;
  return {
    ask: (request: Record<string, unknown> & { type: ChatRequest['type'] }) => {
      const id = `m${nextId++}`;
      socket.send(JSON.stringify({ ...request, id }));
      return new Promise<ChatEvent>((answered) => {
        const check = () => {
          const event = events.find((candidate) => candidate.inReplyTo === id);
          if (event === undefined) return;
          waiting.delete(check);
          answered(event);
        };
        waiting.add(check);
        check();
      });
    },
  };
};
type Client = Awaited<ReturnType<typeof client>>;

const reply = (event: ChatEvent): ChatReply => {
  if (event.type !== 'reply') throw new Error(`expected a reply, got ${JSON.stringify(event)}`);
  return event;
};

/** The data of the button labelled `label` under `question`. */
const dataOf = (question: ChatReply, label: string): string => {
  const button = question.buttons.find((candidate) => candidate.label === label);
  if (button === undefined || !('data' in button)) throw new Error(`no "${label}" button`);
  return button.data;
};

const press = async (chat: Client, question: ChatReply, label: string) =>
  reply(
    await chat.ask({
      type: 'button',
      data: dataOf(question, label),
      channelRef: question.channelRef,
    }),
  );

const grants = async (chat: Client): Promise<ChatConnectionGrant[]> => {
  const event = await chat.ask({ type: 'connection_grants' });
  if (event.type !== 'connection_grants') throw new Error(`got ${JSON.stringify(event)}`);
  return event.grants;
};

const permissions = () => {
  const db = new Database(join(scratch, 'anomander.db'), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT operation, conditions_json, revoked_at FROM permissions
         WHERE operation = 'call_connection_tool' ORDER BY id`,
      )
      .all() as { operation: string; conditions_json: string; revoked_at: string | null }[];
  } finally {
    db.close();
  }
};

/** Asks for `notes__create` and answers "Permitir siempre": the grant the tests start from. */
const grantCreate = async (chat: Client) => {
  tooled = [calls('notes__create', { title: SECRET_TITLE }), says('Apuntado.')];
  const question = reply(await chat.ask({ type: 'connect', task: TASK }));
  expect(await press(chat, question, 'Permitir siempre')).toMatchObject({ text: 'Apuntado.' });
  made = [];
};

/** A task whose one call is `name`: its reply, the question when it asks. */
const taskCalling = async (chat: Client, name: string, args: Arguments = {}) => {
  tooled = [calls(name, args), says('Hecho.')];
  return reply(await chat.ask({ type: 'connect', task: TASK }));
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-grants-'));
  api = await startFakeTelegramApi();
  sockets = [];
  connected = [server('notes'), server('mail')];
  tooled = [];
  made = [];
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(async () => {
  await stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('"Permitir siempre" on a call of a task with connections (DK-24)', () => {
  it('AC1, AC4: the question offers it, with a readable line above the exact arguments', async () => {
    const chat = await client(await start());

    const question = await taskCalling(chat, 'notes__create', {
      title: SECRET_TITLE,
      tags: ['viaje', 'hotel'],
      body: `${'Reserva confirmada para dos noches '.repeat(3)}fin`,
    });

    expect(question.buttons.map((button) => button.label)).toEqual([
      'Permitir',
      'Permitir siempre',
      'Detener',
    ]);
    expect(dataOf(question, 'Permitir siempre')).toMatch(/^connection:[0-9a-f-]{36}:always$/);
    const [line, ...json] = question.text.split('\n');
    expect(line).toBe(
      'Quiero usar «create» de «notes» con: title «Hotel Sol de Belém», tags ["viaje","hotel"], body «Reserva confirmada para dos noches Reserva confirmada para …»',
    );
    expect(JSON.parse(json.join('\n'))).toEqual({
      title: SECRET_TITLE,
      tags: ['viaje', 'hotel'],
      body: `${'Reserva confirmada para dos noches '.repeat(3)}fin`,
    });
    expect((await taskCalling(chat, 'notes__delete')).text).toBe(
      'Quiero usar «delete» de «notes», sin datos.\n{}',
    );
  });

  it('AC1, AC2: once granted, the next call of that tool of that server runs without asking', async () => {
    const chat = await client(await start());
    tooled = [calls('notes__create', { title: SECRET_TITLE }), says('Apuntado.')];
    const question = reply(await chat.ask({ type: 'connect', task: TASK }));

    expect(made).toEqual([]);
    expect((await press(chat, question, 'Permitir siempre')).text).toBe('Apuntado.');
    expect(made).toEqual([{ server: 'notes', tool: 'create', args: { title: SECRET_TITLE } }]);

    const next = await taskCalling(chat, 'notes__create', { title: 'Otra' });

    expect(next.text).toBe('Hecho.');
    expect(next.buttons).toEqual([]);
    expect(made).toHaveLength(2);
    expect(await grants(chat)).toEqual([
      { id: expect.any(Number), server: 'notes', tool: 'create', at: expect.any(String) },
    ]);
    expect(permissions()).toEqual([
      {
        operation: 'call_connection_tool',
        conditions_json: JSON.stringify({
          server: 'notes',
          tool: 'create',
          identity: 'id-notes',
          door: 'app',
        }),
        revoked_at: null,
      },
    ]);
  });

  it('AC2: another tool of that server, and the same tool of another server, still ask', async () => {
    const chat = await client(await start());
    await grantCreate(chat);

    const other = await taskCalling(chat, 'notes__delete', { id: '7' });
    expect(other.buttons.map((button) => button.label)).toContain('Permitir');
    const elsewhere = await taskCalling(chat, 'mail__create', { title: 'x' });
    expect(elsewhere.text).toMatch(/^Quiero usar «create» de «mail»/);

    expect(made).toEqual([]);
  });

  it('AC2: once another server answered in the task, a granted tool still asks (DK-11 AC4)', async () => {
    const chat = await client(await start());
    await grantCreate(chat);
    tooled = [
      calls('mail__search', { query: 'Lisboa' }),
      calls('notes__create', { title: 'x' }),
      says('Hecho.'),
    ];

    const question = reply(await chat.ask({ type: 'connect', task: TASK }));

    expect(question.text).toMatch(/^Quiero usar «create» de «notes»/);
    expect(made).toEqual([{ server: 'mail', tool: 'search', args: { query: 'Lisboa' } }]);
  });

  it('AC2: a server whose command or address changed is asked again', async () => {
    const chat = await client(await start());
    await grantCreate(chat);
    connected = [server('notes', 'another-command'), server('mail')];

    const question = await taskCalling(chat, 'notes__create', { title: 'x' });

    expect(question.buttons.map((button) => button.label)).toContain('Permitir siempre');
    expect(made).toEqual([]);
  });

  it('AC2: a server that cannot be told apart is never offered it', async () => {
    connected = [server('notes', null)];
    const chat = await client(await start());

    const question = await taskCalling(chat, 'notes__create', { title: 'x' });

    expect(question.buttons.map((button) => button.label)).toEqual(['Permitir', 'Detener']);
  });

  it('AC3: "Quitar" revokes it, and the next call asks again', async () => {
    const chat = await client(await start());
    await grantCreate(chat);
    const [grant] = await grants(chat);

    expect(await chat.ask({ type: 'revoke_connection_grant', grantId: grant?.id })).toMatchObject({
      type: 'done',
    });

    expect(await grants(chat)).toEqual([]);
    expect(permissions()[0]?.revoked_at).toEqual(expect.any(String));
    expect((await taskCalling(chat, 'notes__create', { title: 'x' })).buttons).toHaveLength(3);
    expect(made).toEqual([]);
  });

  it('AC5: the processor cannot grant one: only the press on the question code opened does', async () => {
    const chat = await client(await start());
    // It asks for the call with the button's words in its arguments, and then claims it.
    tooled = [
      calls('notes__create', { title: 'connection:00000000-0000-0000-0000-000000000000:always' }),
    ];
    const question = reply(await chat.ask({ type: 'connect', task: TASK }));
    const forged = dataOf(question, 'Permitir siempre').replace(/:[0-9a-f-]{36}:/, ':forged:');

    const answer = reply(
      await chat.ask({ type: 'button', data: forged, channelRef: question.channelRef }),
    );
    expect(answer.text).toBe('Esa petición ya no está pendiente.');
    tooled = [says('Ya tengo «Permitir siempre» para create.')];
    expect((await press(chat, question, 'Permitir')).text).toBe(
      'Ya tengo «Permitir siempre» para create.',
    );

    expect(await grants(chat)).toEqual([]);
    expect(permissions()).toEqual([]);
    expect((await taskCalling(chat, 'notes__create', { title: 'x' })).buttons).toHaveLength(3);
  });

  it('AC6: no log carries the arguments of a call, asked, granted or run unasked', async () => {
    const chat = await client(await start());
    await grantCreate(chat);
    await taskCalling(chat, 'notes__create', { title: SECRET_TITLE });

    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(logged).not.toContain('Hotel Sol');
  });

  describe('asked from Telegram', () => {
    const fromPrincipal = { chatId: PRINCIPAL };
    const buttonsOf = (message: FakeTelegramApi['sent'][number] | undefined) => {
      const markup = message?.payload.reply_markup as
        | { inline_keyboard: { text: string; callback_data: string }[][] }
        | undefined;
      return markup?.inline_keyboard[0] ?? [];
    };

    it('AC1: offers it there too, and a press there grants it for both doors', async () => {
      const chat = await client(await start());
      tooled = [calls('notes__create', { title: SECRET_TITLE }), says('Apuntado.')];
      api.push(updates.text(fromPrincipal, `/mcp ${TASK}`));
      const [question] = await api.waitForSent(1);
      const buttons = buttonsOf(question);
      expect(buttons.map((button) => button.text)).toEqual([
        'Permitir',
        'Permitir siempre',
        'Detener',
      ]);

      api.push(
        updates.callbackQuery(
          fromPrincipal,
          buttons[1]?.callback_data ?? '',
          question?.messageId ?? 0,
        ),
      );
      expect((await api.waitForSent(2))[1]?.text).toBe('Apuntado.');

      tooled = [calls('notes__create', { title: 'x' }), says('Hecho.')];
      api.push(updates.text(fromPrincipal, `/mcp ${TASK}`));
      expect((await api.waitForSent(3))[2]?.text).toBe('Hecho.');
      expect(made).toHaveLength(2);
      expect(JSON.parse(permissions()[0]?.conditions_json ?? '{}')).toMatchObject({
        door: 'telegram',
      });
      expect((await taskCalling(chat, 'notes__create', { title: 'y' })).text).toBe('Hecho.');
    });
  });
});

// Each test starts the daemon and a real server process more than once.
describe('the grants follow mcp.json (DK-24 AC2, AC3)', { timeout: 20_000 }, () => {
  /**
   * `mcp.json` with the server `env`, a real MCP server whose one tool is `names`: by name, its
   * extra arguments and its `env`; `secrets` is `ANOMANDER_MCP_SECRETS`, as the app hands it.
   */
  const withServer = (
    servers: Record<string, string[] | { args?: string[]; env: Record<string, string> }>,
    secrets?: Record<string, string>,
  ) => {
    const path = join(scratch, 'mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: Object.fromEntries(
          Object.entries(servers).map(([name, server]) => {
            const { args = [], env = {} } = Array.isArray(server) ? { args: server } : server;
            return [
              name,
              {
                command: process.execPath,
                args: [resolve(FIXTURES, 'mcp-env-server.mjs'), ...args],
                env,
              },
            ];
          }),
        ),
      }),
    );
    return {
      ANOMANDER_MCP_CONFIG: path,
      ...(secrets === undefined ? {} : { ANOMANDER_MCP_SECRETS: JSON.stringify(secrets) }),
    };
  };

  const grantNames = async (env: Record<string, string>) => {
    const chat = await client(await start(env, true));
    tooled = [calls('env__names', {}), says('Hecho.')];
    const question = reply(await chat.ask({ type: 'connect', task: TASK }));
    expect((await press(chat, question, 'Permitir siempre')).text).toBe('Hecho.');
    expect(await grants(chat)).toHaveLength(1);
    await stop();
  };

  it('keeps them for a server that did not change', async () => {
    await grantNames(withServer({ env: [] }));

    const chat = await client(await start(withServer({ env: [] }), true));

    expect(await grants(chat)).toHaveLength(1);
    tooled = [calls('env__names', {}), says('Sin preguntar.')];
    expect(reply(await chat.ask({ type: 'connect', task: TASK })).text).toBe('Sin preguntar.');
  });

  it("drops them when the server's command changed", async () => {
    await grantNames(withServer({ env: [] }));

    const chat = await client(await start(withServer({ env: ['--otro'] }), true));

    expect(await grants(chat)).toEqual([]);
    expect(permissions()[0]?.revoked_at).toEqual(expect.any(String));
  });

  it('drops them when a variable of its environment changed, or a new one was added', async () => {
    await grantNames(withServer({ env: { env: { MODE: 'a' } } }));
    const changed = await client(await start(withServer({ env: { env: { MODE: 'b' } } }), true));
    expect(await grants(changed)).toEqual([]);
    await stop();

    await grantNames(withServer({ env: { env: { MODE: 'b' } } }));
    const added = await client(
      await start(withServer({ env: { env: { MODE: 'b', NODE_OPTIONS: '' } } }), true),
    );
    expect(await grants(added)).toEqual([]);
  });

  it('keeps them when only a value kept in the Keychain changed, as a new token', async () => {
    const keychain = { env: { env: { TOKEN: '@keychain' } } };
    await grantNames(withServer(keychain, { 'mcp/env/env/TOKEN': 'old-token' }));

    const chat = await client(
      await start(withServer(keychain, { 'mcp/env/env/TOKEN': 'new-token' }), true),
    );

    expect(await grants(chat)).toHaveLength(1);
  });

  it('B67: drops them all when mcp.json is gone, and none when it cannot be read', async () => {
    const env = withServer({ env: [] });
    await grantNames(env);
    writeFileSync(env.ANOMANDER_MCP_CONFIG, '{ not json');
    const unreadable = await client(await start(env, true));
    expect(await grants(unreadable)).toHaveLength(1);
    await stop();

    rmSync(env.ANOMANDER_MCP_CONFIG);
    const gone = await client(await start(env, true));

    // No file is no server: a grant of a server that is not there holds for nothing.
    expect(await grants(gone)).toEqual([]);
    expect(permissions()[0]?.revoked_at).toEqual(expect.any(String));
  });

  it('B67: one stored that cannot be read grants nothing and is logged by its id only', async () => {
    const env = withServer({ env: [] });
    await grantNames(env);
    const written = new Database(join(scratch, 'anomander.db'));
    const id = Number(
      written
        .prepare(
          `INSERT INTO permissions (operation, conditions_json, granted_at)
           VALUES ('call_connection_tool', ?, '2026-11-28T10:00:00.000Z')`,
        )
        .run('{"server":"env","tool":"names","identity":"secret-token"').lastInsertRowid,
    );
    written.close();

    const chat = await client(await start(env, true));

    expect(await grants(chat)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'a connection grant cannot be read; it grants nothing',
      { id },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-token');
  });

  it('drops them when the server was removed, and adding it again does not bring them back', async () => {
    await grantNames(withServer({ env: [] }));
    const chat = await client(await start(withServer({}), true));
    expect(await grants(chat)).toEqual([]);
    await stop();

    const again = await client(await start(withServer({ env: [] }), true));

    expect(await grants(again)).toEqual([]);
    tooled = [calls('env__names', {})];
    expect(reply(await again.ask({ type: 'connect', task: TASK })).buttons).toHaveLength(3);
  });
});
