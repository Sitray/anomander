import { WEB_SEARCH_CONNECTION, WEB_SEARCH_PACKAGE, WEB_SEARCH_VERSION } from '@anomander/protocol';
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
    const { programFor } = await import('../../src/connections/web-search.ts');
    const preset = {
      kind: 'process' as const,
      command: WEB_SEARCH_CONNECTION.command,
      args: [...WEB_SEARCH_CONNECTION.args],
      env: { ...WEB_SEARCH_CONNECTION.env },
      readOnly: [...WEB_SEARCH_CONNECTION.readOnly],
    };
    const warn = vi.fn();
    const connections = createConnections({
      config: { Internet: preset },
      logger: { info: () => {}, warn, error: () => {}, debug: () => {} } as never,
    });

    expect(await connections.get()).toEqual([]);
    expect(connections.unreachable()).toEqual(['Internet']);
    expect(warn).toHaveBeenCalledWith('could not connect to a server', {
      server: 'Internet',
      reason: 'Error',
    });
    // B53 (R3-version-test-reason-too-coarse): the log names only the kind of error, so the
    // version is what the preset's program refuses, and nothing else.
    expect(() => programFor(preset)).toThrow(
      `${WEB_SEARCH_PACKAGE} 0.47.0 is installed, ${WEB_SEARCH_VERSION} is pinned`,
    );
    await connections.close();
  });
});
