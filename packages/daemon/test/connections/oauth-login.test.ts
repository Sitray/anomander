import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectWithOAuth } from '../../src/connections/oauth-login.ts';
import { authorize, type OAuthFixture, startOAuthServer } from '../fixtures/oauth-server.ts';

// DK-11 OAuth: connecting the app to an HTTP server that asks for OAuth. The principal opens the
// address in the browser; the redirect comes back to this machine.

let fixture: OAuthFixture;

beforeEach(async () => {
  fixture = await startOAuthServer();
});

afterEach(async () => {
  await fixture.close();
});

describe('connecting with OAuth', () => {
  it('registers the app, opens the address, and gets the tokens with the code and PKCE', async () => {
    let page: { status: number; text: string } | undefined;
    const outcome = await connectWithOAuth({
      url: fixture.mcpUrl,
      open: async (address) => {
        page = await authorize(address);
      },
    });

    expect(outcome.kind).toBe('connected');
    if (outcome.kind !== 'connected') return;
    expect(outcome.entry.tokens).toMatchObject({
      access_token: fixture.access(),
      refresh_token: fixture.refresh(),
      token_type: 'Bearer',
    });
    expect(outcome.entry.client).toMatchObject({ client_id: 'client-1' });
    expect(outcome.entry.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // The app registered itself for exactly that address, with no secret of its own.
    const registered = JSON.parse(
      fixture.seen.find((request) => request.path === '/register')?.body ?? '{}',
    );
    expect(registered).toMatchObject({
      redirect_uris: [outcome.entry.redirectUrl],
      token_endpoint_auth_method: 'none',
      client_name: 'ANOMANDER',
    });
    expect(page).toEqual({ status: 200, text: expect.stringContaining('Ya puedes cerrar') });
  });

  it('takes the redirect only with the state it sent, and keeps waiting for it', async () => {
    const pages: number[] = [];
    const outcome = await connectWithOAuth({
      url: fixture.mcpUrl,
      open: async (address) => {
        // A page that guessed the address but not the state, then the real redirect.
        const forged = await fetch(
          `${new URL(new URL(address).searchParams.get('redirect_uri') ?? '').href}?code=code-x&state=forged`,
        );
        pages.push(forged.status);
        pages.push((await authorize(address)).status);
      },
    });

    expect(pages).toEqual([400, 200]);
    expect(outcome.kind).toBe('connected');
  });

  it('answers a request it cannot read, and keeps waiting for the redirect', async () => {
    const answers: string[] = [];
    const outcome = await connectWithOAuth({
      url: fixture.mcpUrl,
      open: async (address) => {
        const port = Number(new URL(new URL(address).searchParams.get('redirect_uri') ?? '').port);
        answers.push(
          await new Promise<string>((done) => {
            const socket = connect(port, '127.0.0.1', () => {
              socket.write('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
            });
            let text = '';
            socket.on('data', (chunk) => {
              text += chunk;
              socket.end();
            });
            socket.on('close', () => done(text.split('\r\n')[0] ?? ''));
          }),
        );
        await authorize(address);
      },
    });

    expect(answers).toEqual(['HTTP/1.1 400 Bad Request']);
    expect(outcome.kind).toBe('connected');
  });

  it('says the principal refused, and stops waiting', async () => {
    const outcome = await connectWithOAuth({
      url: fixture.mcpUrl,
      open: async (address) => {
        await authorize(address, (back) => {
          const refused = new URL(back.origin + back.pathname);
          refused.searchParams.set('error', 'access_denied');
          refused.searchParams.set('state', back.searchParams.get('state') ?? '');
          return refused;
        });
      },
    });

    expect(outcome).toEqual({ kind: 'denied' });
  });

  it('gives up when nobody comes back in time, and closes its port', async () => {
    let callback = '';
    const outcome = await connectWithOAuth({
      url: fixture.mcpUrl,
      timeoutMs: 200,
      open: async (address) => {
        callback = new URL(address).searchParams.get('redirect_uri') ?? '';
      },
    });

    expect(outcome).toEqual({ kind: 'timed_out' });
    await expect(fetch(callback)).rejects.toThrow();
  });

  it('fails without quoting the server when it offers no OAuth', async () => {
    await expect(
      connectWithOAuth({ url: 'http://127.0.0.1:9/mcp', open: async () => {} }),
    ).rejects.toThrow();
  });
});

describe('the script the app runs', () => {
  const script = resolve(import.meta.dirname, '../../scripts/mcp-oauth.ts');

  const run = (args: string[], onLine: (line: string) => Promise<void> = async () => {}) =>
    new Promise<{ lines: string[]; stderr: string; code: number | null }>((done) => {
      const child = spawn(process.execPath, [script, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const lines: string[] = [];
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const pending: Promise<void>[] = [];
      createInterface({ input: child.stdout }).on('line', (line) => {
        lines.push(line);
        pending.push(onLine(line));
      });
      child.on('close', async (code) => {
        await Promise.all(pending);
        done({ lines, stderr, code });
      });
    });

  it('prints the address to open, then the tokens on one line, then its outcome', async () => {
    const { lines, code } = await run([fixture.mcpUrl], async (line) => {
      if (line.startsWith('anomander oauth-open ')) {
        await authorize(line.slice('anomander oauth-open '.length));
      }
    });

    expect(code).toBe(0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^anomander oauth-open https?:\/\//);
    expect(lines[1]?.startsWith('anomander oauth-done ')).toBe(true);
    const entry = JSON.parse(lines[1]?.slice('anomander oauth-done '.length) ?? '{}');
    expect(entry.tokens.access_token).toBe(fixture.access());
    expect(lines[2]).toBe('connected');
  });

  it('prints only its outcome when the principal refuses', async () => {
    const { lines, code } = await run([fixture.mcpUrl], async (line) => {
      if (line.startsWith('anomander oauth-open ')) {
        await authorize(line.slice('anomander oauth-open '.length), (back) => {
          const refused = new URL(back.origin + back.pathname);
          refused.searchParams.set('error', 'access_denied');
          refused.searchParams.set('state', back.searchParams.get('state') ?? '');
          return refused;
        });
      }
    });

    expect(code).toBe(0);
    expect(lines.at(-1)).toBe('denied');
    expect(lines.some((line) => line.startsWith('anomander oauth-done'))).toBe(false);
  });

  it('says only why it failed, and exits 1; without an address, 2', async () => {
    const failed = await run(['http://127.0.0.1:9/mcp']);
    expect(failed.code).toBe(1);
    expect(failed.lines).toEqual([]);
    expect(failed.stderr).toMatch(/^could not connect with OAuth: \w+\n$/);
    expect(failed.stderr).not.toContain('127.0.0.1');

    expect((await run([])).code).toBe(2);
    expect((await run(['not a url'])).code).toBe(2);
  });
});
