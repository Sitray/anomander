import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exitCodes } from '@anomander/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// B8: an error nobody caught is written through the daemon's scrubbed log, never raw, and the
// daemon still stops with a failure. `fixtures/crash-after-start.ts` makes it crash once started.
const MAIN = resolve(import.meta.dirname, '../../src/main.ts');
const CRASH = resolve(import.meta.dirname, '../fixtures/crash-after-start.ts');
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
  how: 'exception' | 'rejection',
  { env = {}, handover = true }: { env?: Record<string, string>; handover?: boolean } = {},
) => {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', CRASH, MAIN], {
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
