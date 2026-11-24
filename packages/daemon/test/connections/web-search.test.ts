import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WEB_SEARCH_CONNECTION, WEB_SEARCH_PACKAGE, WEB_SEARCH_VERSION } from '@anomander/protocol';
import { describe, expect, it } from 'vitest';
import type { ProcessServer } from '../../src/connections/config.ts';
import { argumentsThatAsk, connectTo, transportFor } from '../../src/connections/mcp-client.ts';
import { programFor } from '../../src/connections/web-search.ts';

// B9: the web search preset runs the copy of `pi-web-access` installed with the daemon, whose
// whole tree `pnpm-lock.yaml` pins, never one `npx` resolves afresh.

/** The preset as `mcp.json` holds it, written by the app now or before. */
const preset = (): ProcessServer => ({
  kind: 'process',
  command: WEB_SEARCH_CONNECTION.command,
  args: [...WEB_SEARCH_CONNECTION.args],
  env: { ...WEB_SEARCH_CONNECTION.env },
  readOnly: [...WEB_SEARCH_CONNECTION.readOnly],
});

const packageOf = (file: string): { name: string; version: string } => {
  let dir = dirname(file);
  while (dir !== dirname(dir)) {
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(`no package.json above ${file}`);
};

describe('B9: the web search preset', () => {
  it('runs the installed, pinned copy with the daemon own node, not npx', () => {
    const { command, args } = programFor(preset());

    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(1);
    expect(packageOf(args[0] as string)).toMatchObject({
      name: WEB_SEARCH_PACKAGE,
      version: WEB_SEARCH_VERSION,
    });
  });

  it('runs the same pinned copy for a file that holds the npx preset of before', () => {
    const before: ProcessServer = {
      kind: 'process',
      command: 'npx',
      args: ['-y', 'pi-web-access@0.48.0'],
      env: { npm_config_ignore_scripts: 'true' },
      readOnly: ['web_search', 'get_search_content'],
    };

    expect(programFor(before)).toEqual(programFor(preset()));
    expect(argumentsThatAsk(before)).toEqual(WEB_SEARCH_CONNECTION.asksWith);
  });

  it('keeps asking with the arguments of T17', () => {
    expect(argumentsThatAsk(preset())).toEqual(WEB_SEARCH_CONNECTION.asksWith);
  });

  it('leaves any other server, another version of the package included, as the file says', () => {
    const other = (command: string, args: string[]): ProcessServer => ({
      ...preset(),
      command,
      args,
    });
    for (const server of [
      other('npx', ['-y', 'pi-web-access@0.47.0']),
      other('npx', ['-y', 'pi-web-access']),
      other('bunx', [...WEB_SEARCH_CONNECTION.args]),
      other('npx', ['-y', 'pi-web-access@0.48.0', '--verbose']),
      other('notes-server', []),
    ]) {
      expect(programFor(server), server.command).toEqual({
        command: server.command,
        args: server.args,
      });
    }
  });

  it('is the version the daemon depends on, so the lockfile pins what the preset names', () => {
    const daemon = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };

    expect(daemon.dependencies[WEB_SEARCH_PACKAGE]).toBe(WEB_SEARCH_VERSION);
  });

  it('starts as a real server and lists the tools the preset names', async () => {
    const { connection, close } = await connectTo('Internet', [], transportFor(preset()));
    const names = connection.tools.map((tool) => tool.name);
    await close();

    expect(names).toEqual(expect.arrayContaining([...WEB_SEARCH_CONNECTION.readOnly]));
    expect(names).toEqual(expect.arrayContaining(Object.keys(WEB_SEARCH_CONNECTION.asksWith)));
  });
});
