// The window in a plain browser, without the Rust shell or a daemon: `pnpm --dir apps/desktop dev`
// and open http://localhost:1420/test/preview/index.html. Tauri's IPC is mocked and the local
// channel is a scripted socket, so every state can be looked at. Never part of a build.
//
// The URL picks the scene:
//   ?daemon=running|starting|failing|not_configured|already_running|bot_in_use|gave_up|
//           stopped_by_principal|failed|unreachable      (default: running)
//   &setup=empty|filled                                   (default: by the daemon's state)
//   &error=long                                           a 300-character last error
//   &fail=start|stop|save                                 that command is refused
//   &connections=none|invalid                             (default: two servers)
//
// The scripted daemon answers by what is typed: "mercadona" asks a Sí/No question, "rechaza" is
// rejected, "corta" loses the connection, "lento" never answers, "largo" answers at length,
// "/login" answers with a link button; a PDF gets S-18 and images are read as a receipt.
import type { ChatButton, ChatRequest } from '@anomander/protocol';
import { emit } from '@tauri-apps/api/event';
import { mockIPC } from '@tauri-apps/api/mocks';
import {
  type ConnectionInput,
  type ConnectionsView,
  type DaemonStatus,
  type SetupInput,
  type SetupState,
  SNAPSHOT_EVENT,
  type Snapshot,
  type StopReason,
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
      default:
        throw `unknown command: ${command}`;
    }
  },
  { shouldMockEvents: true },
);

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

type Answer = { text: string; buttons?: ChatButton[] } | 'rejected' | 'drop' | 'never';

const answerTo = (request: ChatRequest): Answer => {
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
  if (text.includes('mercadona')) {
    return {
      text: 'Apuntado: 40,00 € en Mercadona, supermercado.\n¿Mercadona siempre es supermercado?',
      buttons: YES_NO,
    };
  }
  return { text: 'Apuntado: 23,00 € en restaurantes.' };
};

class ScriptedSocket extends FakeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    setTimeout(() => this.open(), 200);
  }

  override send(data: string): void {
    super.send(data);
    const request = JSON.parse(data) as ChatRequest;
    const answer = answerTo(request);
    if (answer === 'never') return;
    setTimeout(() => {
      if (answer === 'drop') this.drop();
      else if (answer === 'rejected') this.receive({ type: 'rejected', inReplyTo: request.id });
      else {
        this.receive({
          type: 'reply',
          inReplyTo: request.id,
          channelRef: `desktop:${crypto.randomUUID()}`,
          text: answer.text,
          buttons: answer.buttons ?? [],
          sentAt: new Date().toISOString(),
        });
      }
    }, 700);
  }
}

// Only the local channel is scripted: Vite's own hot-reload socket stays real.
window.WebSocket = new Proxy(window.WebSocket, {
  construct: (target, [url, protocols]: [string | URL, string | string[] | undefined]) =>
    String(url) === CHANNEL.url ? new ScriptedSocket(url, protocols) : new target(url, protocols),
});

await import('../../src/main.tsx');
