import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  loadConnectionsConfig,
  parseConnectionsConfig,
  readConnections,
} from '../../src/connections/config.ts';
import { connectTo, createConnections, transportFor } from '../../src/connections/mcp-client.ts';

// DK-11: the MCP side. A real client against a real server of the SDK, joined in memory: no
// process is started and nothing leaves this one.

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A server with a reading tool, a failing one and one that answers a picture. */
const serve = async () => {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });
  server.registerTool(
    'search',
    { description: 'Searches the notes', inputSchema: { query: z.string() } },
    async ({ query }) => ({ content: [{ type: 'text', text: `found: ${query}` }] }),
  );
  server.registerTool('broken', { description: 'Fails' }, async () => {
    throw new Error('the disk is full');
  });
  server.registerTool('picture', { description: 'A picture' }, async () => ({
    content: [
      { type: 'text', text: 'here it is' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  }));
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  await server.connect(theirs);
  return { transport: ours, server };
};

describe('DK-11: a connected MCP server', () => {
  it('lists its tools with their schema, and keeps what the principal marked read-only', async () => {
    const { transport } = await serve();

    const { connection, close } = await connectTo('notes', ['search', 'missing'], transport);

    expect(connection.name).toBe('notes');
    expect(connection.tools.map((tool) => tool.name)).toEqual(['search', 'broken', 'picture']);
    expect(connection.tools[0]).toMatchObject({
      description: 'Searches the notes',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    });
    expect([...connection.readOnly]).toEqual(['search', 'missing']);
    await close();
  });

  it('calls a tool and answers its text; what is not text is only named', async () => {
    const { transport } = await serve();
    const { connection, close } = await connectTo('notes', [], transport);

    expect(await connection.call('search', { query: 'Lisboa' })).toEqual({
      text: 'found: Lisboa',
      isError: false,
    });
    expect(await connection.call('picture', {})).toEqual({
      text: 'here it is\n[image left out]',
      isError: false,
    });
    expect(await connection.call('broken', {})).toMatchObject({ isError: true });
    await close();
  });
});

describe('DK-11: a server started as a process', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('gets the variables of its configuration and none of the daemon own', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot:secret');
    vi.stubEnv('GEMINI_API_KEY', 'key-secret');
    vi.stubEnv('ANOMANDER_LOCAL_TOKEN', 'local-secret');
    const transport = transportFor({
      kind: 'process',
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/mcp-env-server.mjs')],
      env: { NOTES_TOKEN: 'abc' },
      readOnly: [],
    });

    const { connection, close } = await connectTo('env', [], transport);
    const names = (await connection.call('names', {})).text.split(',');
    await close();

    expect(names).toContain('NOTES_TOKEN');
    expect(names).toContain('PATH');
    expect(names.filter((name) => /TOKEN|KEY|ANOMANDER/.test(name))).toEqual(['NOTES_TOKEN']);
  });
});

describe('DK-11: a server reached over HTTP', () => {
  let http: Server;
  let requests: { url: string; authorization: string | undefined }[];
  const address = () => `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  beforeEach(async () => {
    requests = [];
    // On this machine only, and stateless: a new MCP server answers each request.
    http = createServer(async (request, response) => {
      requests.push({ url: request.url ?? '', authorization: request.headers.authorization });
      if (request.url === '/moved') {
        response.writeHead(307, { Location: `${address()}/mcp` }).end();
        return;
      }
      const server = new McpServer({ name: 'remote', version: '1.0.0' });
      server.registerTool(
        'search',
        { description: 'Searches', inputSchema: { query: z.string() } },
        async ({ query }) => ({ content: [{ type: 'text', text: `found: ${query}` }] }),
      );
      const transport = new StreamableHTTPServerTransport({});
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response);
    });
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  });
  afterEach(async () => {
    http.closeAllConnections();
    await new Promise((done) => http.close(done));
  });

  const remote = (path: string) =>
    transportFor({
      kind: 'http',
      url: `${address()}${path}`,
      headers: { Authorization: 'Bearer abc' },
      readOnly: [],
    });

  it('sends the configured headers with every request, and calls a tool', async () => {
    const { connection, close } = await connectTo('remote', [], remote('/mcp'));

    expect(connection.tools.map((tool) => tool.name)).toEqual(['search']);
    expect(await connection.call('search', { query: 'Lisboa' })).toEqual({
      text: 'found: Lisboa',
      isError: false,
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.authorization === 'Bearer abc')).toBe(true);
    await close();
  });

  it('does not follow a redirect: the headers go nowhere the principal did not write', async () => {
    await expect(connectTo('remote', [], remote('/moved'))).rejects.toThrow();

    expect(requests.map((request) => request.url)).toEqual(['/moved']);
  });
});

describe('DK-11: the connections, made when a task first needs them', () => {
  const config = parseConnectionsConfig({
    mcpServers: {
      notes: { command: 'notes-server', readOnly: ['search'] },
      down: { url: 'https://example.com/mcp' },
    },
  });

  it('connects each server once, and leaves out one that cannot be reached until it can', async () => {
    const log = logger();
    let reachable = false;
    let clock = 1_000_000;
    const opened: string[] = [];
    const connections = createConnections({
      config,
      logger: log,
      now: () => clock,
      open: async (name) => {
        opened.push(name);
        if (name === 'down' && !reachable) throw new Error('ECONNREFUSED https://user:secret@x');
        return (await serve()).transport;
      },
    });
    expect(opened).toEqual([]);

    expect((await connections.get()).map((connection) => connection.name)).toEqual(['notes']);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret');
    expect(connections.unreachable()).toEqual(['down']);

    // A server that just failed is not tried again by the next task: it would wait for it.
    reachable = true;
    clock += 59_000;
    expect((await connections.get()).map((connection) => connection.name)).toEqual(['notes']);
    expect(opened).toEqual(['notes', 'down']);

    clock += 1_000;
    expect((await connections.get()).map((connection) => connection.name)).toEqual([
      'notes',
      'down',
    ]);
    expect(opened).toEqual(['notes', 'down', 'down']);
    expect(connections.unreachable()).toEqual([]);
    expect([...((await connections.get())[0]?.readOnly ?? [])]).toEqual(['search']);
    await connections.close();
  });

  it('closing waits for a connection being made, and nothing is connected after', async () => {
    const opened: string[] = [];
    let open: () => void = () => {};
    const gate = new Promise<void>((done) => {
      open = done;
    });
    const closed = vi.fn();
    const connections = createConnections({
      config: parseConnectionsConfig({ mcpServers: { notes: { command: 'notes-server' } } }),
      logger: logger(),
      open: async (name) => {
        opened.push(name);
        await gate;
        const { transport, server } = await serve();
        server.server.onclose = closed;
        return transport;
      },
    });

    const getting = connections.get();
    await vi.waitFor(() => expect(opened).toEqual(['notes']));
    const closing = connections.close();
    open();
    await Promise.all([getting, closing]);

    // The server that was being connected is not left running.
    expect(closed).toHaveBeenCalled();
    expect(await connections.get()).toEqual([]);
    expect(opened).toEqual(['notes']);
  });

  it('connects again to a server whose connection broke under a call', async () => {
    let broken = false;
    const opened: string[] = [];
    const connections = createConnections({
      config: parseConnectionsConfig({ mcpServers: { notes: { url: 'https://example.com/mcp' } } }),
      logger: logger(),
      open: async (name) => {
        opened.push(name);
        const { transport } = await serve();
        const send = transport.send.bind(transport);
        // As an HTTP server that forgot the session: every request fails from then on.
        transport.send = async (message, options) => {
          if (broken) throw new Error('404 session not found');
          return send(message, options);
        };
        return transport;
      },
    });
    const [first] = await connections.get();
    expect(await first?.call('search', { query: 'a' })).toMatchObject({ text: 'found: a' });

    broken = true;
    await expect(first?.call('search', { query: 'b' })).rejects.toThrow();
    broken = false;

    const [second] = await connections.get();
    expect(opened).toEqual(['notes', 'notes']);
    expect(await second?.call('search', { query: 'c' })).toMatchObject({ text: 'found: c' });
    // A tool that fails is the tool's answer, not a broken connection.
    expect(await second?.call('broken', {})).toMatchObject({ isError: true });
    await connections.get();
    expect(opened).toEqual(['notes', 'notes']);
    await connections.close();
  });
});

describe('DK-11: mcp.json', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anomander-mcp-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads servers started as a process and servers reached over HTTPS', () => {
    const path = join(dir, 'mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          notes: {
            command: 'npx',
            args: ['-y', 'notes-mcp'],
            env: { NOTES_TOKEN: 'abc' },
            readOnly: ['search'],
          },
          remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' } },
          local: { url: 'http://127.0.0.1:8080/mcp' },
        },
      }),
    );

    expect(loadConnectionsConfig(path, logger())).toEqual({
      notes: {
        kind: 'process',
        command: 'npx',
        args: ['-y', 'notes-mcp'],
        env: { NOTES_TOKEN: 'abc' },
        readOnly: ['search'],
      },
      remote: {
        kind: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer abc' },
        readOnly: [],
      },
      local: { kind: 'http', url: 'http://127.0.0.1:8080/mcp', headers: {}, readOnly: [] },
    });
  });

  it('fills each `@keychain` value with the secret the app handed over', () => {
    const path = join(dir, 'mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          notes: { command: 'npx', env: { NOTES_TOKEN: '@keychain', DEBUG: '1' } },
          remote: { url: 'https://example.com/mcp', headers: { Authorization: '@keychain' } },
        },
      }),
    );
    const secrets = JSON.stringify({
      'mcp/notes/env/NOTES_TOKEN': 'abc',
      'mcp/remote/headers/Authorization': 'Bearer xyz',
    });

    const log = logger();
    expect(loadConnectionsConfig(path, log, secrets)).toEqual({
      notes: {
        kind: 'process',
        command: 'npx',
        args: [],
        env: { NOTES_TOKEN: 'abc', DEBUG: '1' },
        readOnly: [],
      },
      remote: {
        kind: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer xyz' },
        readOnly: [],
      },
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('leaves out a server whose secret was not handed over, and only that server', () => {
    const path = join(dir, 'mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          notes: { command: 'npx', env: { NOTES_TOKEN: '@keychain' } },
          remote: { url: 'https://example.com/mcp', headers: { Authorization: '@keychain' } },
          plain: { command: 'plain-mcp' },
        },
      }),
    );
    const secrets = JSON.stringify({ 'mcp/notes/env/NOTES_TOKEN': 'abc' });

    const log = logger();
    expect(Object.keys(loadConnectionsConfig(path, log, secrets))).toEqual(['notes', 'plain']);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[1]).toEqual({ server: 'remote', missing: 'Authorization' });

    // Without the app there is nothing to fill a marker with: it is never sent as the value.
    expect(Object.keys(loadConnectionsConfig(path, logger()))).toEqual(['plain']);
  });

  it('takes secrets that are not a JSON object of texts as none, without logging them', () => {
    const path = join(dir, 'mcp.json');
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { notes: { command: 'npx', env: { T: '@keychain' } } } }),
    );
    for (const secrets of ['hunter2-not-json', JSON.stringify({ 'mcp/notes/env/T': 7 })]) {
      const log = logger();
      expect(loadConnectionsConfig(path, log, secrets), secrets).toEqual({});
      expect(JSON.stringify(log.error.mock.calls), secrets).not.toContain('hunter2');
    }
  });

  it('says what kept servers out: a file that is wrong, or a secret nobody handed over', () => {
    const path = join(dir, 'mcp.json');
    expect(readConnections(join(dir, 'none.json'), logger())).toEqual({
      config: {},
      invalid: false,
      leftOut: [],
    });

    writeFileSync(path, '{ not json');
    expect(readConnections(path, logger())).toEqual({ config: {}, invalid: true, leftOut: [] });

    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          remote: { url: 'https://example.com/mcp', headers: { Authorization: '@keychain' } },
          plain: { command: 'plain-mcp' },
        },
      }),
    );
    const read = readConnections(path, logger());
    expect(Object.keys(read.config)).toEqual(['plain']);
    expect(read).toMatchObject({ invalid: false, leftOut: ['remote'] });
  });

  it('is no connections when the file is missing or no path was given', () => {
    expect(loadConnectionsConfig(join(dir, 'none.json'), logger())).toEqual({});
    expect(loadConnectionsConfig(undefined, logger())).toEqual({});
  });

  it('refuses the whole file when any of it is wrong, without logging what it holds', () => {
    const wrong = [
      '{ not json',
      JSON.stringify({ servers: {} }),
      JSON.stringify({ mcpServers: { a: { command: '' } } }),
      JSON.stringify({ mcpServers: { a: { command: 'x', url: 'https://x.y' } } }),
      // Plain HTTP would carry the headers and the task in the clear.
      JSON.stringify({ mcpServers: { a: { url: 'http://example.com/mcp' } } }),
      JSON.stringify({ mcpServers: { a: { url: 'file:///etc/passwd' } } }),
      JSON.stringify({ mcpServers: { 'a»b': { command: 'x' } } }),
      JSON.stringify({ mcpServers: { a: { command: 'x', shell: true } } }),
    ];
    for (const text of wrong) {
      const path = join(dir, 'mcp.json');
      writeFileSync(path, `${text}\n`);
      const log = logger();
      expect(loadConnectionsConfig(path, log), text).toEqual({});
      expect(log.error, text).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.error.mock.calls)).not.toContain('example.com');
    }
  });
});
