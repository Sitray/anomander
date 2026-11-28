import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exitCodes } from '@anomander/protocol';
import { type FakeTelegramApi, startFakeTelegramApi } from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// B8: an error nobody caught is written through the daemon's scrubbed log, never raw, and the
// daemon still stops with a failure. `fixtures/crash-after-start.ts` makes it crash once started.
const MAIN = resolve(import.meta.dirname, '../../src/main.ts');
const CRASH = resolve(import.meta.dirname, '../fixtures/crash-after-start.ts');
/** Sends the bot's calls to `ANOMANDER_TEST_TELEGRAM_API_ROOT` instead of Telegram. */
const TELEGRAM_AT = resolve(import.meta.dirname, '../crash/telegram-at.ts');
const LOCAL_TOKEN = 'main-crash-local-token-0123456789abcdef';
const OPENAI_KEY = 'sk-proj-main-crash-0123456789abcdef';
const NOTES_TOKEN = 'notes-secret-main-crash-0123456789';
// What Windows itself needs in a child's environment (see `main-without-telegram.test.ts`).
const SYSTEM = ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'PATHEXT'];

let scratch: string;
let daemon: ChildProcess | undefined;

const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address !== null
          ? resolvePort(address.port)
          : reject(new Error('no port')),
      );
    });
  });

/**
 * Starts `main.ts` as the desktop app does, the secrets handed over on stdin, and has it crash
 * `how` with an error whose message holds them. Resolves with its exit code and all its output,
 * once its stdout and stderr have closed: an `exit` can come before the last of them is read.
 * `env` is laid over the child's environment; `handover: false` never writes the secrets.
 */
const crash = async (
  how: 'exception' | 'rejection' | 'flood',
  {
    env = {},
    handover = true,
    imports = [],
    onExit = () => {},
  }: {
    env?: Record<string, string>;
    handover?: boolean;
    /** More modules preloaded with `--import`, after the crash fixture. */
    imports?: string[];
    /** Told as soon as the process exits, before its output is closed. */
    onExit?: () => void;
  } = {},
) => {
  const port = await freePort();
  const preloads = [CRASH, ...imports].flatMap((path) => ['--import', path]);
  const child = spawn(process.execPath, [...preloads, MAIN], {
    cwd: scratch,
    env: {
      ...Object.fromEntries(
        SYSTEM.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
      ),
      PATH: process.env.PATH ?? '',
      HOME: scratch,
      ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
      ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
      ANOMANDER_AUTH_PATH: join(scratch, 'auth.json'),
      ANOMANDER_LOCAL_PORT: String(port),
      ANOMANDER_SECRETS_ON_STDIN: '1',
      ANOMANDER_TEST_CRASH: how,
      ANOMANDER_TEST_CRASH_MESSAGE: `the model refused ${OPENAI_KEY} and the server ${NOTES_TOKEN}`,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  daemon = child;
  child.once('exit', () => onExit());
  if (handover) {
    child.stdin?.write(
      `${JSON.stringify({
        ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN,
        OPENAI_API_KEY: OPENAI_KEY,
        ANOMANDER_MCP_SECRETS: JSON.stringify({ 'mcp/notes/env/NOTES_TOKEN': NOTES_TOKEN }),
      })}\n`,
    );
  }
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolveClose) =>
    child.once('close', resolveClose),
  );
  return { code, output };
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-main-crash-'));
});

afterEach(() => {
  daemon?.kill('SIGKILL');
  daemon = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

describe('main.ts when an error is not caught', () => {
  it('logs an unhandled rejection scrubbed and exits with a failure', async () => {
    const { code, output } = await crash('rejection');

    expect(code).toBe(exitCodes.failed);
    expect(output).toContain('anomander daemon crashed: unhandled rejection');
    expect(output).toContain('the model refused [secret] and the server [secret]');
    expect(output).not.toContain(OPENAI_KEY);
    expect(output).not.toContain(NOTES_TOKEN);
  }, 20_000);

  it('logs an uncaught exception scrubbed and exits with a failure', async () => {
    const { code, output } = await crash('exception');

    expect(code).toBe(exitCodes.failed);
    expect(output).toContain('anomander daemon crashed: uncaught exception');
    expect(output).toContain('the model refused [secret] and the server [secret]');
    expect(output).not.toContain(OPENAI_KEY);
    expect(output).not.toContain(NOTES_TOKEN);
  }, 20_000);

  it('writes the whole crash line before it exits, even behind a full pipe', async () => {
    const { code, output } = await crash('exception', {
      env: { ANOMANDER_TEST_CRASH_FLOOD: String(4 * 1024 * 1024) },
    });

    expect(code).toBe(exitCodes.failed);
    expect(output).toContain('anomander daemon crashed: uncaught exception');
    expect(output).toContain('the model refused [secret] and the server [secret]');
  }, 20_000);

  it('B51: writes the whole failure line before it exits, even behind a full pipe', async () => {
    // No front door: the configuration fails at once, behind 4 MiB the log still holds.
    const { code, output } = await crash('flood', {
      env: {
        ANOMANDER_SECRETS_ON_STDIN: '',
        ANOMANDER_TEST_CRASH_AFTER: 'anomander daemon starting',
        ANOMANDER_TEST_CRASH_FLOOD: String(4 * 1024 * 1024),
      },
      handover: false,
    });

    expect(code).toBe(exitCodes.failed);
    expect(output).toContain('anomander daemon failed: missing configuration: no front door');
  }, 20_000);

  it('scrubs a crash before the configuration is read of the keys it already has', async () => {
    // Still waiting for the handover: only the environment's provider key is known.
    const { code, output } = await crash('exception', {
      env: { OPENAI_API_KEY: OPENAI_KEY, ANOMANDER_TEST_CRASH_AFTER: 'anomander daemon starting' },
      handover: false,
    });

    expect(code).toBe(exitCodes.failed);
    expect(output).toContain('anomander daemon crashed: uncaught exception');
    expect(output).not.toContain(OPENAI_KEY);
  }, 20_000);
});

// B85 (R3-crash-exit-wiring): `main.ts` hands `exitOnceWritten` the promise of `daemon.halt()`, so
// a crash exits only once the halt settled, the bot's last `getUpdates` included (B84). The test
// holds the answer to that `getUpdates` for `ACK_HELD_MS`: a crash exit that did not wait for the
// halt would be gone long before, once its log is out.
describe('main.ts when an error is not caught, with Telegram', () => {
  const PRINCIPAL = 4242;
  const ACK_HELD_MS = 750;
  const MODELS = {
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
  };
  let api: FakeTelegramApi | undefined;
  let proxy: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((closed) =>
      proxy === undefined ? closed() : proxy.close(() => closed()),
    );
    proxy?.closeAllConnections();
    proxy = undefined;
    await api?.close();
    api = undefined;
  });

  /**
   * A Bot API in front of the fake one that tells `seen` once it answered the `getUpdates` a stop
   * sends to acknowledge what it read (`limit: 1`, no long poll), which it holds `ACK_HELD_MS`.
   */
  const holdingAck = async (fake: FakeTelegramApi, seen: string[]): Promise<string> => {
    proxy = createHttpServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();
      const answer = await fetch(`${fake.apiRoot}${req.url}`, {
        method: req.method ?? 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        ...(req.method === 'GET' ? {} : { body }),
      }).catch(() => undefined);
      if (answer === undefined) {
        res.destroy();
        return;
      }
      const text = await answer.text();
      const payload = (body.startsWith('{') ? JSON.parse(body) : {}) as Record<string, unknown>;
      const acknowledges =
        req.url?.endsWith('/getUpdates') === true &&
        payload.limit === 1 &&
        payload.timeout === undefined;
      if (acknowledges) {
        res.once('finish', () => seen.push('acknowledgement answered'));
        await new Promise((held) => setTimeout(held, ACK_HELD_MS));
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(text);
    });
    await new Promise<void>((listening) => proxy?.listen(0, '127.0.0.1', () => listening()));
    const { port } = proxy.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  it.each([
    ['the daemon', MODELS, false],
    ['the setup guide', {}, true],
  ])(
    '%s exits only once its halt has acknowledged the last updates to Telegram',
    async (_, models, guide) => {
      api = await startFakeTelegramApi();
      const seen: string[] = [];
      const root = await holdingAck(api, seen);

      const { code, output } = await crash('exception', {
        env: {
          ...models,
          TELEGRAM_BOT_TOKEN: api.token,
          ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
          ANOMANDER_TEST_TELEGRAM_API_ROOT: root,
          ANOMANDER_TEST_CRASH_AFTER: 'anomander is listening on Telegram',
        },
        imports: [TELEGRAM_AT],
        onExit: () => seen.push('exit'),
      });

      expect(code).toBe(exitCodes.failed);
      expect(output).toContain('anomander daemon crashed: uncaught exception');
      // The setup guide says why it runs before the bot listens; the daemon has no model gap.
      expect(output.includes('setup incomplete: ANOMANDER_MODEL')).toBe(guide);
      expect(seen).toEqual(['acknowledgement answered', 'exit']);
    },
    20_000,
  );
});
