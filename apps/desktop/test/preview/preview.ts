// The window in a plain browser, without the Rust shell or a daemon: `pnpm --dir apps/desktop dev`
// and open http://localhost:1420/test/preview/index.html. Tauri's IPC is mocked and the local
// channel is a scripted socket, so every state can be looked at. Never part of a build.
//
// The URL picks the scene:
//   ?daemon=running|starting|failing|not_configured|already_running|bot_in_use|gave_up|
//           stopped_by_principal|failed|unreachable      (default: running)
//   &setup=empty|filled                                   (default: by the daemon's state)
//   &error=long                                           a 300-character last error
//   &fail=start|stop|save|oauth|login                     that command is refused
//   &connections=none|invalid                             (default: two servers)
//   &subscriptions=none|connected                         (default: none; connected: ChatGPT and Claude)
//   &history=none                                         nothing kept of the conversation (DK-16)
//   &expenses=none|fail                                   no expense in any month, or the daemon fails to read them (DK-17)
//   &memory=none|failing                                  nothing remembered or done, or the store fails (DK-18)
//
// The scripted daemon answers by what is typed: "mercadona" asks a Sí/No question, "rechaza" is
// rejected, "corta" loses the connection, "lento" never answers, "largo" answers at length,
// "/login" answers with a link button, "pantalla" is routed to a look and "ordenador" to a task
// on the computer (DK-13); a PDF gets S-18 and images are read as a receipt. It keeps the
// conversation as the daemon does, starting with some of it, Telegram included (DK-16).
import {
  type ChatAction,
  type ChatButton,
  type ChatEvent,
  type ChatExpenses,
  type ChatMemory,
  type ChatReply,
  type ChatRequest,
  type ChatStoredMessage,
  HISTORY_LIMIT,
  strings,
} from '@anomander/protocol';
import { emit } from '@tauri-apps/api/event';
import { mockIPC } from '@tauri-apps/api/mocks';
import {
  type ConnectionInput,
  type ConnectionsView,
  type DaemonStatus,
  LOGIN_EVENT,
  type LoginStep,
  type SetupInput,
  type SetupState,
  SNAPSHOT_EVENT,
  type Snapshot,
  type StopReason,
  type SubscriptionsView,
} from '../../src/shell.ts';
import { FakeWebSocket } from '../fake-web-socket.ts';
import {
  CHANNEL,
  CONNECTIONS,
  EMPTY_SETUP,
  FILLED_SETUP,
  RUNNING,
  STARTING,
  stopped,
} from '../fixtures.ts';

const params = new URLSearchParams(location.search);
const scene = params.get('daemon') ?? 'running';
const refused = params.get('fail');

const SHORT_ERROR = 'Error: connect ECONNREFUSED 127.0.0.1:443';
const LONG_ERROR =
  'Error: SQLITE_CANTOPEN: unable to open database file /Users/principal/Library/Application Support/ANOMANDER/anomander.db: the-directory-name-is-far-too-long-to-fit-in-a-single-line-without-wrapping-and-has-no-spaces-at-all; retried 3 times; last attempt at 2026-11-10T10:00:00.000Z; giving up until the principal starts it again.';
const lastError = params.get('error') === 'long' ? LONG_ERROR : SHORT_ERROR;

const REASONS: StopReason[] = [
  'not_configured',
  'already_running',
  'bot_in_use',
  'gave_up',
  'stopped_by_principal',
];

const daemonFor = (name: string): DaemonStatus => {
  const reason = REASONS.find((candidate) => candidate === name);
  if (reason !== undefined) return stopped(reason, reason === 'gave_up' ? lastError : null);
  if (name === 'starting') return STARTING;
  if (name === 'failing') return { state: 'failing', reason: null, lastError };
  if (name === 'failed') return stopped(null, lastError.replace('Error:', 'spawn node ENOENT:'));
  return RUNNING;
};

const setupFor = (daemon: DaemonStatus): SetupState => {
  const asked = params.get('setup');
  if (asked !== null) return asked === 'empty' ? EMPTY_SETUP : FILLED_SETUP;
  return daemon.reason === 'not_configured' ? EMPTY_SETUP : FILLED_SETUP;
};

let snapshot: Snapshot = (() => {
  const daemon = daemonFor(scene);
  return {
    daemon,
    channel: daemon.state === 'running' ? CHANNEL : null,
    setup: setupFor(daemon),
  };
})();

const publish = (next: Partial<Snapshot>, afterMs = 0): void => {
  setTimeout(() => {
    snapshot = { ...snapshot, ...next };
    void emit(SNAPSHOT_EVENT, snapshot);
  }, afterMs);
};

const comeUp = (): void => {
  publish({ daemon: STARTING, channel: null });
  publish({ daemon: RUNNING, channel: CHANNEL }, 1200);
};

/** The shell's side of `save_setup`, with its own English refusals. */
const saveSetup = (input: SetupInput): Snapshot => {
  if (refused === 'save') throw 'could not store TELEGRAM_BOT_TOKEN';
  const providerKeys = new Set(snapshot.setup.providerKeys);
  for (const [name, value] of Object.entries(input.providerKeys)) {
    if (value === null) providerKeys.delete(name);
    else providerKeys.add(name);
  }
  const setup: SetupState = {
    hasTelegramBotToken: snapshot.setup.hasTelegramBotToken || input.telegramBotToken !== undefined,
    principalChatId: input.principalChatId === '' ? null : input.principalChatId,
    model: input.model === '' ? null : input.model,
    visionModel: input.visionModel === '' ? null : input.visionModel,
    providerKeys: [...providerKeys],
  };
  const ready = setup.hasTelegramBotToken && setup.principalChatId !== null;
  snapshot = {
    setup,
    channel: null,
    daemon: ready ? STARTING : stopped('not_configured'),
  };
  if (ready) publish({ daemon: RUNNING, channel: CHANNEL }, 1200);
  return snapshot;
};

/** `mcp.json` as the shell would show it. */
const SUBSCRIBED = params.get('subscriptions') === 'connected';
let subscriptions: SubscriptionsView = {
  accounts: [
    { providerId: 'openai', connected: SUBSCRIBED, login: true },
    { providerId: 'kimi-coding', connected: false, login: true },
    { providerId: 'anthropic', connected: SUBSCRIBED, login: false },
    { providerId: 'github-copilot', connected: false, login: false },
  ],
};
/** Ends the ChatGPT login that waits for a pasted address. */
let answerLogin: () => void = () => {};

let connections: ConnectionsView =
  params.get('connections') === 'none'
    ? { servers: [], invalid: null }
    : params.get('connections') === 'invalid'
      ? { servers: [], invalid: 'mcp.json is not as the daemon reads it: mcpServers.notes.type' }
      : CONNECTIONS;

/** The shell's side of `save_connection`: a typed value is only ever remembered as stored. */
const saveConnection = ({ original, values, ...server }: ConnectionInput): ConnectionsView => {
  if (refused === 'save') throw 'could not store mcp/notes/env/API_KEY in the Keychain';
  const before = connections.servers.find((known) => known.name === original);
  const saved = {
    ...server,
    oauth: before?.oauth === true && before.kind === server.kind,
    values: values.map(({ name, value }) => ({
      name,
      stored:
        value !== undefined ||
        before?.values.some((kept) => kept.name === name && kept.stored) === true,
    })),
  };
  const servers = connections.servers.map((known) => (known.name === original ? saved : known));
  connections = { servers: before === undefined ? [...servers, saved] : servers, invalid: null };
  comeUp();
  return connections;
};

mockIPC(
  (command, payload) => {
    switch (command) {
      case 'get_snapshot':
        if (scene === 'unreachable') throw 'the shell failed: channel closed';
        return snapshot;
      case 'start_daemon':
        if (refused === 'start') throw 'the shell failed: no free port on 127.0.0.1: os error 48';
        comeUp();
        return undefined;
      case 'stop_daemon':
        if (refused === 'stop') throw 'the shell failed: the daemon did not stop';
        publish({ daemon: stopped('stopped_by_principal'), channel: null });
        return undefined;
      case 'save_setup':
        return saveSetup((payload as { setup: SetupInput }).setup);
      case 'get_connections':
        return connections;
      case 'save_connection':
        return saveConnection((payload as { server: ConnectionInput }).server);
      case 'remove_connection': {
        const { name } = payload as { name: string };
        connections = {
          servers: connections.servers.filter((known) => known.name !== name),
          invalid: null,
        };
        comeUp();
        return connections;
      }
      case 'capture_screen':
        return screenCapture();
      case 'reveal':
      case 'set_task_running':
        return undefined;
      // B25: a browser page stands in for the principal's browser.
      case 'open_link':
        window.open((payload as { url: string }).url, '_blank', 'noopener');
        return undefined;
      // DK-15: the subscription logins. ChatGPT opens the browser and waits for a pasted address
      // (or 6 seconds); Kimi Code shows a device code. `fail=login` shows a failure.
      case 'get_subscriptions':
        return subscriptions;
      case 'connect_subscription': {
        const { providerId } = payload as { providerId: string };
        const step = (next: LoginStep) => emit(LOGIN_EVENT, next);
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (refused === 'login') {
              reject('login failed: TypeError');
              return;
            }
            if (providerId === 'kimi-coding') step({ kind: 'device_code', code: 'HWKT-9F2Q' });
            else {
              step({ kind: 'opened' });
              step({ kind: 'prompt' });
            }
            const finish = () => {
              subscriptions = {
                accounts: subscriptions.accounts.map((account) =>
                  account.providerId === providerId ? { ...account, connected: true } : account,
                ),
              };
              resolve({ outcome: 'connected' });
            };
            const timer = setTimeout(finish, 6000);
            answerLogin = () => {
              clearTimeout(timer);
              setTimeout(finish, 800);
            };
          }, 700);
        });
      }
      case 'answer_login':
        answerLogin();
        return undefined;
      case 'disconnect_subscription': {
        const { providerId } = payload as { providerId: string };
        subscriptions = {
          accounts: subscriptions.accounts.map((account) =>
            account.providerId === providerId ? { ...account, connected: false } : account,
          ),
        };
        comeUp();
        return subscriptions;
      }
      case 'connect_oauth':
      case 'forget_oauth': {
        // The principal takes a moment in the browser; `refused=oauth` shows a failure.
        const { name } = payload as { name: string };
        const connected = command === 'connect_oauth';
        return new Promise((resolve, reject) =>
          setTimeout(
            () => {
              if (refused === 'oauth') {
                reject('could not connect with OAuth: ECONNREFUSED');
                return;
              }
              connections = {
                servers: connections.servers.map((known) =>
                  known.name === name ? { ...known, oauth: connected } : known,
                ),
                invalid: null,
              };
              resolve(connected ? { outcome: 'connected' } : connections);
            },
            connected ? 1500 : 0,
          ),
        );
      }
      default:
        throw `unknown command: ${command}`;
    }
  },
  { shouldMockEvents: true },
);

/** A plain JPEG in place of the screen: the preview never sees the real one. */
const screenCapture = async (): Promise<ArrayBuffer> => {
  const canvas = new OffscreenCanvas(640, 360);
  const context = canvas.getContext('2d');
  if (context !== null) {
    context.fillStyle = '#7a9cc6';
    context.fillRect(0, 0, 640, 360);
  }
  return (await canvas.convertToBlob({ type: 'image/jpeg' })).arrayBuffer();
};

// ---------- The scripted daemon ----------

const YES_NO: ChatButton[] = [
  { label: 'Sí', data: 'policy:yes' },
  { label: 'No', data: 'policy:no' },
];
const LONG_REPLY = [
  'Esto es lo que llevas gastado este mes:',
  '',
  'Supermercado: 312,40 €',
  'Restaurantes: 148,00 €',
  'Transporte: 61,90 €',
  'Sin clasificar: 23,00 €',
  '',
  'Y una palabra sin espacios para ver que no rompe nada: https://example.com/una/ruta/larguisima/que/no/tiene/ningun/espacio/y/sigue/y/sigue/y/sigue/hasta/el/final',
].join('\n');

/** The decisions already answered: a second press gets S-19, as in the daemon. */
const closed = new Set<string>();

type Answer =
  | { text: string; buttons?: ChatButton[]; route?: ChatReply['route'] }
  | 'rejected'
  | 'drop'
  | 'never';

/** The requests the daemon answers by what was said; the stored conversation is apart. */
type Said = Exclude<
  ChatRequest,
  {
    type:
      | 'history'
      | 'clear_history'
      | 'expenses'
      | 'memories'
      | 'forget_memory'
      | 'actions'
      | 'forget_action'
      | 'ai_usage'
      | 'connection_grants'
      | 'revoke_connection_grant'
      | 'probe_model'
      | 'cancel';
  }
>;

const answerTo = (request: Said): Answer => {
  if (request.type === 'button') {
    if (closed.has(request.channelRef)) return { text: 'Esa pregunta ya no está abierta.' };
    closed.add(request.channelRef);
    return request.data === 'policy:yes'
      ? { text: 'Hecho, he guardado la regla «Mercadona es supermercado».' }
      : { text: 'Vale, no guardo ninguna regla.' };
  }
  if (request.type === 'receipt') {
    const types = request.images.map((image) => image.mimeType);
    if (types.includes('application/pdf')) {
      return { text: 'De momento no leo PDF. Envíame una foto del ticket.' };
    }
    if (types.some((type) => !type.startsWith('image/'))) {
      return { text: 'De momento solo entiendo texto y fotos de tickets.' };
    }
    return { text: 'Apuntado: 47,85 € en Mercadona, supermercado, 12 líneas.' };
  }
  // DK-17 AC6: a row's "Deshacer" and "Corregir", answered as the expense's buttons in the chat.
  if (request.type === 'undo_expense' || request.type === 'correct_expense') {
    const row = `expense:${request.expenseId}`;
    if (closed.has(row)) return { text: 'Esa pregunta ya no está abierta.' };
    if (request.type === 'correct_expense')
      return { text: '¿Qué cambio? Escríbelo, por ejemplo: total 28,40' };
    closed.add(row);
    return { text: 'Deshecho: he quitado 23,00 € de tus gastos.' };
  }
  if (request.type === 'screen') return { text: 'Veo una pantalla de un solo color.' };
  if (request.type === 'computer') return { text: 'En esta vista previa no toco nada. Hecho.' };
  const text = ('task' in request ? request.task : request.text).toLowerCase();
  if (text.includes('rechaza')) return 'rejected';
  if (text.includes('corta')) return 'drop';
  if (text.includes('lento')) return 'never';
  if (text.includes('largo')) return { text: LONG_REPLY };
  if (text.includes('/login')) {
    return {
      text: 'Abre este enlace para entrar con tu cuenta.',
      buttons: [{ label: 'Abrir', url: 'https://example.com/login' }],
    };
  }
  if (request.type === 'text' && text.includes('pantalla')) {
    return { text: 'Miro tu pantalla.', route: { to: 'screen', task: request.text } };
  }
  if (request.type === 'text' && text.includes('ordenador')) {
    return {
      text: 'Me pongo con ello en tu ordenador.',
      route: { to: 'computer', task: request.text },
    };
  }
  if (text.includes('mercadona')) {
    return {
      text: 'Apuntado: 40,00 € en Mercadona, supermercado.\n¿Mercadona siempre es supermercado?',
      buttons: YES_NO,
    };
  }
  return { text: 'Apuntado: 23,00 € en restaurantes.' };
};

// DK-17: the expenses of a month, as the daemon reads them from its views: some in this month and
// the previous one, every mode, and two pending apart.
const thisMonth = new Date().toISOString().slice(0, 7);
const expensesOf = (month: string): Omit<ChatExpenses, 'inReplyTo'> => {
  const shown =
    params.get('expenses') === 'none' || month < '2026-01'
      ? []
      : [
          {
            day: '02',
            merchant: null,
            category: 'restaurantes',
            basis: 'inferred',
            cents: 2300,
            mode: 'declared',
          },
          {
            day: '05',
            merchant: 'Mercadona',
            category: 'supermercado',
            basis: 'policy',
            cents: 4785,
            mode: 'corroborated',
            lines: 12,
          },
          {
            day: '11',
            merchant: 'Café Sol',
            category: 'restaurantes',
            basis: 'inferred',
            cents: 320,
            mode: 'inferred',
            lines: 2,
          },
          {
            day: '18',
            merchant: 'Lidl',
            category: null,
            basis: null,
            cents: 1599,
            mode: 'confirmed',
            lines: 4,
          },
        ].map((row, index) => ({
          id: index + 1,
          date: `${month}-${row.day}`,
          merchant: row.merchant,
          category: row.category,
          totalCents: row.cents,
          mode: row.mode as ChatExpenses['expenses'][number]['mode'],
          categoryMode: row.basis as ChatExpenses['expenses'][number]['categoryMode'],
          origin: row.lines === undefined ? ('text' as const) : ('receipt' as const),
          lines: row.lines ?? 0,
        }));
  return {
    type: 'expenses',
    month,
    expenses: shown,
    totalCents: shown.reduce((sum, row) => sum + row.totalCents, 0),
    pending: { count: 2, totalCents: 1500 },
  };
};

// DK-16: the stored conversation, from both doors; gone with the page, unlike the daemon's.
const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();
let kept: ChatStoredMessage[] =
  params.get('history') === 'none'
    ? []
    : [
        {
          id: 1,
          from: 'principal',
          door: 'telegram',
          text: '40 € mercadona',
          buttons: [],
          channelRef: null,
          at: at(90),
        },
        {
          id: 2,
          from: 'anomander',
          door: 'telegram',
          text: 'Apuntado: 40,00 € en Mercadona, supermercado.\n¿Mercadona siempre es supermercado?',
          buttons: YES_NO,
          channelRef: 'telegram:4242:17',
          at: at(90),
        },
        {
          id: 3,
          from: 'principal',
          door: 'app',
          text: '[foto de ticket] cena',
          buttons: [],
          channelRef: null,
          at: at(30),
        },
        {
          id: 4,
          from: 'anomander',
          door: 'app',
          text: 'Apuntado: 47,85 € en Mercadona, supermercado, 12 líneas.',
          buttons: [],
          channelRef: 'desktop:stored-4',
          at: at(30),
        },
      ];
let lastKept = kept.length;

const keep = (message: Omit<ChatStoredMessage, 'id' | 'door' | 'at'>): void => {
  lastKept += 1;
  kept.push({ ...message, id: lastKept, door: 'app', at: new Date().toISOString() });
};

// DK-18: what the daemon remembers and what it did, as the window's "Memoria" lists them.
const memoryScene = params.get('memory');
let memories: ChatMemory[] =
  memoryScene === 'none'
    ? []
    : [
        { id: 3, text: 'Se llama Eric', mode: 'declared' },
        { id: 7, text: 'Es vegetariano', mode: 'declared' },
        { id: 9, text: 'Suele cenar fuera los viernes', mode: 'inferred' },
      ];
let actions: ChatAction[] =
  memoryScene === 'none'
    ? []
    : [
        {
          id: 12,
          what: 'computer',
          door: 'app',
          task: 'Envía a Marta el resumen de gastos de noviembre',
          outcome: 'done',
          at: at(45),
        },
        {
          id: 11,
          what: 'screen',
          door: 'app',
          task: '¿Qué pone en este correo?',
          outcome: 'answer',
          at: at(60 * 26),
        },
        {
          id: 10,
          what: 'connect',
          door: 'telegram',
          task: 'Busca vuelos a Lisboa para el viernes',
          outcome: 'stopped',
          at: at(60 * 50),
        },
      ];

const MEMORY_REQUESTS = ['memories', 'actions', 'forget_memory', 'forget_action'] as const;
type MemoryRequest = ChatRequest & { type: (typeof MEMORY_REQUESTS)[number] };
const isMemoryRequest = (request: ChatRequest): request is MemoryRequest =>
  MEMORY_REQUESTS.some((type) => type === request.type);

/** DK-18: the answer to a request of the window's "Memoria". */
const memoryAnswer = (request: MemoryRequest): ChatEvent => {
  if (memoryScene === 'failing') {
    return {
      type: 'reply',
      inReplyTo: request.id,
      channelRef: 'desktop:failing',
      text: 'Algo ha fallado al procesar tu mensaje.',
      buttons: [],
      sentAt: new Date().toISOString(),
    };
  }
  switch (request.type) {
    case 'memories':
      return { type: 'memories', inReplyTo: request.id, memories };
    case 'actions':
      return { type: 'actions', inReplyTo: request.id, actions };
    case 'forget_memory':
      memories = memories.filter(({ id }) => id !== request.memoryId);
      return { type: 'done', inReplyTo: request.id };
    case 'forget_action':
      actions = actions.filter(({ id }) => id !== request.actionId);
      return { type: 'done', inReplyTo: request.id };
  }
};

/** What the daemon keeps of a request: its words, never an image. */
const wordsOf = (request: ChatRequest): string | null => {
  if (request.type === 'text') return request.text;
  if (request.type === 'receipt') return `[foto de ticket] ${request.caption ?? ''}`.trim();
  if (request.type === 'button') return `[botón: ${request.data}]`;
  return null;
};

class ScriptedSocket extends FakeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    setTimeout(() => this.open(), 200);
  }

  override send(data: string): void {
    super.send(data);
    const request = JSON.parse(data) as ChatRequest;
    if (isMemoryRequest(request)) {
      setTimeout(() => this.receive(memoryAnswer(request)), 300);
      return;
    }
    // DK-21: today's AI calls, for the setup.
    if (request.type === 'ai_usage') {
      setTimeout(
        () => this.receive({ type: 'ai_usage', inReplyTo: request.id, calls: 12, limit: 200 }),
        300,
      );
      return;
    }
    if (request.type === 'expenses') {
      setTimeout(() => {
        if (params.get('expenses') === 'fail') {
          this.receive({
            type: 'reply',
            inReplyTo: request.id,
            channelRef: `desktop:${crypto.randomUUID()}`,
            text: strings.processingFailed(),
            buttons: [],
            sentAt: new Date().toISOString(),
          });
        } else {
          this.receive({ ...expensesOf(request.month ?? thisMonth), inReplyTo: request.id });
        }
      }, 300);
      return;
    }
    // DK-19: the preview never holds a turn it could stop.
    if (request.type === 'cancel') {
      this.receive({ type: 'done', inReplyTo: request.id });
      return;
    }
    // DK-24: the preview grants nothing, so it lists none and every "Quitar" is done.
    if (request.type === 'connection_grants' || request.type === 'revoke_connection_grant') {
      setTimeout(() => {
        this.receive(
          request.type === 'connection_grants'
            ? { type: 'connection_grants', inReplyTo: request.id, grants: [] }
            : { type: 'done', inReplyTo: request.id },
        );
      }, 300);
      return;
    }
    // DK-23 AC4: "Probar" in the setup, on its own connection.
    if (request.type === 'probe_model') {
      const outcome = params.get('probe') ?? 'ok';
      setTimeout(
        () => this.receiveRaw(JSON.stringify({ type: 'probe', inReplyTo: request.id, outcome })),
        700,
      );
      return;
    }
    if (request.type === 'history' || request.type === 'clear_history') {
      setTimeout(() => {
        if (request.type === 'clear_history') {
          kept = [];
          this.receive({ type: 'done', inReplyTo: request.id });
        } else {
          const messages = kept.slice(-HISTORY_LIMIT);
          this.receive({ type: 'history', inReplyTo: request.id, messages });
        }
      }, 300);
      return;
    }
    const words = wordsOf(request);
    if (words !== null) keep({ from: 'principal', text: words, buttons: [], channelRef: null });
    const answer = answerTo(request);
    if (answer === 'never') return;
    setTimeout(() => {
      if (answer === 'drop') this.drop();
      else if (answer === 'rejected') this.receive({ type: 'rejected', inReplyTo: request.id });
      else {
        const channelRef = `desktop:${crypto.randomUUID()}`;
        const buttons = answer.buttons ?? [];
        keep({ from: 'anomander', text: answer.text, buttons, channelRef });
        this.receive({
          type: 'reply',
          inReplyTo: request.id,
          channelRef,
          text: answer.text,
          buttons,
          ...(answer.route === undefined ? {} : { route: answer.route }),
          sentAt: new Date().toISOString(),
        });
      }
    }, 700);
  }
}

// Every frame, `history` included, is answered by the scripted daemon.
FakeWebSocket.history = null;

// Only the local channel is scripted: Vite's own hot-reload socket stays real.
window.WebSocket = new Proxy(window.WebSocket, {
  construct: (target, [url, protocols]: [string | URL, string | string[] | undefined]) =>
    String(url) === CHANNEL.url ? new ScriptedSocket(url, protocols) : new target(url, protocols),
});

await import('../../src/main.tsx');
