import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConnectionsConfig, parseConnectionsConfig } from '../../src/connections/config.ts';
import { connectTo, createConnections } from '../../src/connections/mcp-client.ts';

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
    const opened: string[] = [];
    const connections = createConnections({
      config,
      logger: log,
      open: async (name) => {
        opened.push(name);
        if (name === 'down' && !reachable) throw new Error('ECONNREFUSED https://user:secret@x');
        return (await serve()).transport;
      },
    });
    expect(opened).toEqual([]);

    expect((await connections.get()).map((connection) => connection.name)).toEqual(['notes']);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret');

    reachable = true;
    expect((await connections.get()).map((connection) => connection.name)).toEqual([
      'notes',
      'down',
    ]);
    expect(opened).toEqual(['notes', 'down', 'down']);
    expect([...((await connections.get())[0]?.readOnly ?? [])]).toEqual(['search']);
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
