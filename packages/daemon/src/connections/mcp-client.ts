import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../processor/text-interpreter.ts';
import type { ConnectionsConfig, ServerConfig } from './config.ts';
import type { Connection, ToolInfo } from './connection.ts';

// DK-11: the MCP client. It connects to the servers of `mcp.json`, lists their tools and calls
// one when `task.ts` decided that call runs. It decides nothing itself.

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
/** How long a server that could not be reached is left alone: a task never waits for it twice. */
const RETRY_AFTER_MS = 60_000;
/** The most pages of tools read from one server. */
const MAX_TOOL_PAGES = 5;

export interface ConnectedServer {
  connection: Connection;
  close(): Promise<void>;
}

/** Connects to the server behind `transport` and reads its tools. */
export const connectTo = async (
  name: string,
  readOnly: readonly string[],
  transport: Transport,
  onClosed: () => void = () => {},
): Promise<ConnectedServer> => {
  const client = new Client({ name: 'anomander', version: '1.0.0' });
  client.onclose = onClosed;
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  const tools: ToolInfo[] = [];
  try {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const listed = await client.listTools(cursor === undefined ? {} : { cursor }, {
        timeout: CONNECT_TIMEOUT_MS,
      });
      for (const tool of listed.tools) {
        tools.push({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        });
      }
      cursor = listed.nextCursor;
      if (cursor === undefined) break;
    }
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return {
    connection: {
      name,
      tools,
      readOnly: new Set(readOnly),
      call: async (tool, args) => {
        const result = await client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: CALL_TIMEOUT_MS,
        });
        const content = Array.isArray(result.content) ? result.content : [];
        return {
          // Only text goes back to the processor: the rest is named.
          text: content
            .map((part: { type: string; text?: unknown }) =>
              part.type === 'text' && typeof part.text === 'string'
                ? part.text
                : `[${part.type} left out]`,
            )
            .join('\n'),
          isError: result.isError === true,
        };
      },
    },
    close: () => client.close(),
  };
};

/** How a configured server is reached. */
export const transportFor = (server: ServerConfig): Transport =>
  server.kind === 'process'
    ? new StdioClientTransport({
        command: server.command,
        args: server.args,
        // The SDK adds only HOME, LOGNAME, PATH, SHELL, TERM and USER: a server never gets the
        // daemon's own environment, which holds its secrets.
        env: server.env,
        // What a server writes to its error output stays out of the daemon's own.
        stderr: 'ignore',
      })
    : new StreamableHTTPClientTransport(new URL(server.url), {
        // A redirect would carry the headers, and the task, to an address nobody configured.
        requestInit: { headers: server.headers, redirect: 'error' },
      });

export interface Connections {
  /** The servers connected now. One not connected yet is tried, and left out if it fails. */
  get(): Promise<Connection[]>;
  /** The configured servers that are not connected, as the last `get` left them. */
  unreachable(): string[];
  /** Closes every server, once any being connected is; nothing is connected after. */
  close(): Promise<void>;
}

export interface ConnectionsDeps {
  config: ConnectionsConfig;
  logger: Logger;
  /** How a server is reached; tests join one in memory. */
  open?: (name: string, server: ServerConfig) => Promise<Transport>;
  now?: () => number;
}

/**
 * Whether `error` means the connection is of no more use: anything but the server's own answer
 * to one request (such as an HTTP server that forgot the session), or the connection closing.
 * A call that timed out says nothing about the next one.
 */
const broke = (error: unknown): boolean =>
  !(error instanceof McpError) || error.code === ErrorCode.ConnectionClosed;

/**
 * The connections, made when a task first needs them: a daemon that is never asked for one
 * starts no server.
 */
export const createConnections = (deps: ConnectionsDeps): Connections => {
  const { config, logger, open = async (_, server) => transportFor(server), now = Date.now } = deps;
  const connected = new Map<string, ConnectedServer>();
  /** When each server last could not be reached. */
  const failedAt = new Map<string, number>();
  const resting = (name: string): boolean => {
    const at = failedAt.get(name);
    return at !== undefined && now() - at < RETRY_AFTER_MS;
  };
  /** One `get` at a time, so a server is never connected twice. */
  let turn: Promise<unknown> = Promise.resolve();
  let closed = false;

  const connectMissing = async (): Promise<Connection[]> => {
    await Promise.all(
      Object.entries(config)
        .filter(([name]) => !connected.has(name) && !resting(name))
        .map(async ([name, server]) => {
          try {
            let entry: ConnectedServer | undefined;
            // Only its own entry: by then the server may be connected again.
            const forget = () => {
              if (entry !== undefined && connected.get(name) === entry) connected.delete(name);
            };
            const made = await connectTo(name, server.readOnly, await open(name, server), forget);
            entry = {
              close: made.close,
              connection: {
                ...made.connection,
                call: async (tool, args) => {
                  try {
                    return await made.connection.call(tool, args);
                  } catch (error) {
                    if (broke(error)) {
                      // The next task connects again.
                      forget();
                      void made.close().catch(() => {});
                    }
                    throw error;
                  }
                },
              },
            };
            connected.set(name, entry);
            failedAt.delete(name);
            logger.info(`connected to ${name} (${made.connection.tools.length} tools)`);
          } catch (error) {
            failedAt.set(name, now());
            // Its code only: a message may quote the address or a header.
            logger.warn('could not connect to a server', {
              server: name,
              reason: (error as NodeJS.ErrnoException).code ?? (error as Error).name,
            });
          }
        }),
    );
    // In the order the principal wrote them.
    return Object.keys(config).flatMap((name) => {
      const server = connected.get(name);
      return server === undefined ? [] : [server.connection];
    });
  };

  return {
    get: () => {
      const next = turn.then(() => (closed ? [] : connectMissing()));
      turn = next.catch(() => {});
      return next;
    },
    unreachable: () => Object.keys(config).filter((name) => !connected.has(name)),
    close: async () => {
      closed = true;
      // After the connection being made, so its server is closed with the others.
      await turn;
      const servers = [...connected.values()];
      connected.clear();
      await Promise.all(servers.map((server) => server.close().catch(() => {})));
    },
  };
};
