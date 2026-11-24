import { WEB_SEARCH_CONNECTION } from '@anomander/protocol';
import { describe, expect, it, vi } from 'vitest';

// B9: when the installed copy is another version than the preset names, the server is left out
// and logged like any server that cannot start, never run unpinned through npx. Its own file:
// it mocks `node:fs` before the module reads the installed package.
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: (path: string, encoding: unknown) =>
      String(path).includes('pi-web-access') && String(path).endsWith('package.json')
        ? JSON.stringify({ version: '0.47.0', bin: { 'pi-web-access-mcp': 'dist/mcp-cli.js' } })
        : real.readFileSync(path, encoding as never),
  };
});

describe('the web search preset with another installed version (B9)', () => {
  it('is left out, never run unpinned', async () => {
    const { createConnections } = await import('../../src/connections/mcp-client.ts');
    const warn = vi.fn();
    const connections = createConnections({
      config: {
        Internet: {
          kind: 'process',
          command: WEB_SEARCH_CONNECTION.command,
          args: [...WEB_SEARCH_CONNECTION.args],
          env: { ...WEB_SEARCH_CONNECTION.env },
          readOnly: [...WEB_SEARCH_CONNECTION.readOnly],
        },
      },
      logger: { info: () => {}, warn, error: () => {}, debug: () => {} } as never,
    });

    expect(await connections.get()).toEqual([]);
    expect(connections.unreachable()).toEqual(['Internet']);
    expect(warn).toHaveBeenCalledWith('could not connect to a server', {
      server: 'Internet',
      reason: 'Error',
    });
    await connections.close();
  });
});
