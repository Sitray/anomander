import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { WEB_SEARCH_CONNECTION, WEB_SEARCH_PACKAGE, WEB_SEARCH_VERSION } from '@anomander/protocol';
import type { ProcessServer } from './config.ts';

// B9: the web search connection runs the copy of `pi-web-access` installed with the daemon. Its
// whole tree is pinned in `pnpm-lock.yaml`; `npx` would resolve what it brings afresh each time.

/** The bin that serves MCP over standard input and output. */
const MCP_BIN = 'pi-web-access-mcp';

let installed: string | undefined;

/**
 * The installed copy's MCP entry point. Throws when it is missing or is another version: the
 * server is then left out, as any server that could not be started, and never run unpinned.
 */
const installedBin = (): string => {
  if (installed !== undefined) return installed;
  const manifest = createRequire(import.meta.url).resolve(`${WEB_SEARCH_PACKAGE}/package.json`);
  const { version, bin } = JSON.parse(readFileSync(manifest, 'utf8')) as {
    version?: string;
    bin?: Record<string, string>;
  };
  const entry = bin?.[MCP_BIN];
  if (version !== WEB_SEARCH_VERSION || entry === undefined) {
    throw new Error(
      `${WEB_SEARCH_PACKAGE} ${version} is installed, ${WEB_SEARCH_VERSION} is pinned`,
    );
  }
  installed = join(dirname(manifest), entry);
  return installed;
};

/** Whether `server` is the preset: its command and arguments exactly, as the app writes them. */
const isPreset = (server: ProcessServer): boolean =>
  server.command === WEB_SEARCH_CONNECTION.command &&
  server.args.length === WEB_SEARCH_CONNECTION.args.length &&
  server.args.every((arg, index) => arg === WEB_SEARCH_CONNECTION.args[index]);

/**
 * The program that starts `server`: the preset runs the installed copy with the daemon's own
 * `node` (on macOS, Windows and in Docker alike); any other server, another version of the same
 * package included, runs as `mcp.json` says.
 */
export const programFor = (server: ProcessServer): { command: string; args: string[] } =>
  isPreset(server)
    ? { command: process.execPath, args: [installedBin()] }
    : { command: server.command, args: server.args };
