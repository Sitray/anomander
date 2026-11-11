import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Logger } from '../processor/text-interpreter.ts';

// DK-11: the servers the principal connected, from `mcp.json` in the data folder. The format is
// the `mcpServers` object other MCP clients read, plus `readOnly`: the tools of that server the
// principal marks as only reading, the only ones that may run without asking.
//
// The desktop app keeps the values of `env` and `headers` in the Keychain (DK-5): it leaves
// `@keychain` in their place and hands the values over in `ANOMANDER_MCP_SECRETS`, a JSON object
// by `mcp/<server>/<env|headers>/<name>`.

/** A server started as a process and spoken to over its standard input and output. */
export interface ProcessServer {
  kind: 'process';
  command: string;
  args: string[];
  /** Added to the few variables a server process inherits; it gets none of the daemon's own. */
  env: Record<string, string>;
  readOnly: string[];
}

/** A server reached over HTTP. */
export interface HttpServer {
  kind: 'http';
  url: string;
  headers: Record<string, string>;
  readOnly: string[];
}

export type ServerConfig = ProcessServer | HttpServer;
/** By the name the principal gave each server. */
export type ConnectionsConfig = Record<string, ServerConfig>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** HTTPS, or plain HTTP to this machine only: anything else would travel in the clear. */
const reachable = (text: string): boolean => {
  if (!URL.canParse(text)) return false;
  const url = new URL(text);
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
};

/** A name shown to the principal inside quotes and used to name the tools. */
const serverName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/);
const readOnly = z.array(z.string().min(1)).default([]);
const variables = z.record(z.string().min(1), z.string()).default({});

const fileSchema = z.strictObject({
  mcpServers: z.record(
    serverName,
    z.union([
      z
        .strictObject({
          command: z.string().min(1),
          args: z.array(z.string()).default([]),
          env: variables,
          readOnly,
        })
        .transform((server): ProcessServer => ({ kind: 'process', ...server })),
      z
        .strictObject({ url: z.string().refine(reachable), headers: variables, readOnly })
        .transform((server): HttpServer => ({ kind: 'http', ...server })),
    ]),
  ),
});

/** The configuration `raw` holds; throws when any of it is not as expected. */
export const parseConnectionsConfig = (raw: unknown): ConnectionsConfig =>
  fileSchema.parse(raw).mcpServers;

/** What the desktop app leaves in the file in place of a value it keeps in the Keychain. */
export const KEPT_SECRET = '@keychain';

const secretsSchema = z.record(z.string(), z.string());

/** The secrets `raw` holds; none when it is not a JSON object of texts. */
const handedOver = (raw: string | undefined, logger: Logger): Record<string, string> => {
  if (raw === undefined) return {};
  try {
    return secretsSchema.parse(JSON.parse(raw));
  } catch {
    // Never what it says: it holds tokens.
    logger.error('the secrets of the connections are not valid; none is used');
    return {};
  }
};

/**
 * `config` with each kept value replaced by its secret. A server with a value nobody handed over
 * is left out: the marker is never sent in the place of a token.
 */
const filled = (
  config: ConnectionsConfig,
  secrets: Record<string, string>,
  logger: Logger,
): ConnectionsConfig => {
  const servers: [string, ServerConfig][] = [];
  for (const [name, server] of Object.entries(config)) {
    const field = server.kind === 'process' ? 'env' : 'headers';
    const values: Record<string, string> = {};
    let missing: string | undefined;
    for (const [key, value] of Object.entries(
      server.kind === 'process' ? server.env : server.headers,
    )) {
      const secret = value === KEPT_SECRET ? secrets[`mcp/${name}/${field}/${key}`] : value;
      if (secret === undefined) missing ??= key;
      else values[key] = secret;
    }
    if (missing !== undefined) {
      logger.error('a secret of a connection was not handed over; the server is not connected', {
        server: name,
        missing,
      });
      continue;
    }
    servers.push([
      name,
      server.kind === 'process' ? { ...server, env: values } : { ...server, headers: values },
    ]);
  }
  return Object.fromEntries(servers);
};

/**
 * Reads `path`; no path or no file is no connections. A file that is wrong anywhere connects
 * nothing: half a configuration is not what the principal wrote. `secrets` is
 * `ANOMANDER_MCP_SECRETS` as it came.
 */
export const loadConnectionsConfig = (
  path: string | undefined,
  logger: Logger,
  secrets?: string,
): ConnectionsConfig => {
  if (path === undefined) return {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    logger.error('could not read the connections file', {
      reason: (error as NodeJS.ErrnoException).code ?? 'unknown',
    });
    return {};
  }
  try {
    return filled(parseConnectionsConfig(JSON.parse(text)), handedOver(secrets, logger), logger);
  } catch (error) {
    // Where it is wrong, never what it says: the file may hold tokens.
    const where =
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.path.join('.')).join(', ')
        : 'not JSON';
    logger.error('the connections file is not valid; no server is connected', { where });
    return {};
  }
};
