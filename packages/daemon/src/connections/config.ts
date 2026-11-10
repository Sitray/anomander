import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Logger } from '../processor/text-interpreter.ts';

// DK-11: the servers the principal connected, from `mcp.json` in the data folder. The format is
// the `mcpServers` object other MCP clients read, plus `readOnly`: the tools of that server the
// principal marks as only reading, the only ones that may run without asking.

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

/**
 * Reads `path`; no path or no file is no connections. A file that is wrong anywhere connects
 * nothing: half a configuration is not what the principal wrote.
 */
export const loadConnectionsConfig = (
  path: string | undefined,
  logger: Logger,
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
    return parseConnectionsConfig(JSON.parse(text));
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
