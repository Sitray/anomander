import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exitCodes, LOCAL_CHANNEL_PROTOCOL } from '@anomander/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// T13: `main.ts` as the desktop app starts it, without a Telegram bot. The local channel is the
// only front door; without it too, the daemon refuses to start and says what it needs.
const MAIN = resolve(import.meta.dirname, '../../src/main.ts');
const TOKEN = 'main-without-telegram-token-0123456789abcdef';

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

/** Starts `main.ts` with `env` and the data paths in the scratch folder; collects its output. */
const run = (env: Record<string, string>) => {
  const child = spawn(process.execPath, [MAIN], {
    cwd: scratch,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: scratch,
      ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
      ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
      ANOMANDER_AUTH_PATH: join(scratch, 'auth.json'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon = child;
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
  const printed = (text: string) =>
    new Promise<void>((resolvePrinted, reject) => {
      const check = () => {
        if (output.includes(text)) resolvePrinted();
      };
      child.stdout?.on('data', check);
      child.stderr?.on('data', check);
      exited.then(() => reject(new Error(`exited before printing ${text}:\n${output}`)));
      check();
    });
  return { exited, printed, output: () => output };
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-main-'));
});

afterEach(() => {
  daemon?.kill('SIGKILL');
  daemon = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

describe('main.ts without Telegram', () => {
  it('starts with the local channel alone and answers the app', async () => {
    const port = await freePort();
    const started = run({ ANOMANDER_LOCAL_TOKEN: TOKEN, ANOMANDER_LOCAL_PORT: String(port) });
    await started.printed(`anomander local channel listening on 127.0.0.1:${port}`);

    // No model is set: the app's chat gets the setup guide (R-28).
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [LOCAL_CHANNEL_PROTOCOL, TOKEN]);
    const answer = new Promise<{ text: string }>((resolveAnswer) =>
      socket.addEventListener('message', (event) => resolveAnswer(JSON.parse(String(event.data)))),
    );
    socket.addEventListener('open', () =>
      socket.send(JSON.stringify({ type: 'text', id: 'm1', text: 'hola' })),
    );
    expect((await answer).text).toContain('ANOMANDER_MODEL');
    socket.close();

    daemon?.kill('SIGTERM');
    expect(await started.exited).toBe(0);
    expect(started.output()).not.toContain('Telegram');
  }, 20_000);

  it('refuses to start without any front door, naming both', async () => {
    const started = run({});
    expect(await started.exited).toBe(exitCodes.failed);
    expect(started.output()).toContain(
      "missing configuration: no front door. Set TELEGRAM_BOT_TOKEN (the token @BotFather gives when you create the bot) and ANOMANDER_PRINCIPAL_CHAT_ID (your Telegram user ID, which @userinfobot tells you) for Telegram, or ANOMANDER_LOCAL_TOKEN for the desktop app's chat",
    );
  }, 20_000);
});
