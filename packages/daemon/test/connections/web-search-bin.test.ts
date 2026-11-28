import { WEB_SEARCH_CONNECTION, WEB_SEARCH_PACKAGE, WEB_SEARCH_VERSION } from '@anomander/protocol';
import { describe, expect, it, vi } from 'vitest';

// B86: the installed copy is the pinned version but has no MCP bin. The server is still left
// out, and the reason names the missing bin, not a version that matches. Its own file: it mocks
// `node:fs` before the module reads the installed package.
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  const { WEB_SEARCH_VERSION: pinned } = await import('@anomander/protocol');
  return {
    ...real,
    readFileSync: (path: string, encoding: unknown) =>
      String(path).includes('pi-web-access') && String(path).endsWith('package.json')
        ? JSON.stringify({ version: pinned, bin: { other: 'dist/other.js' } })
        : real.readFileSync(path, encoding as never),
  };
});

describe('the web search preset installed without its MCP bin (B86)', () => {
  it('is left out, and says the bin is missing', async () => {
    const { programFor } = await import('../../src/connections/web-search.ts');
    const preset = {
      kind: 'process' as const,
      command: WEB_SEARCH_CONNECTION.command,
      args: [...WEB_SEARCH_CONNECTION.args],
      env: { ...WEB_SEARCH_CONNECTION.env },
      readOnly: [...WEB_SEARCH_CONNECTION.readOnly],
    };

    expect(() => programFor(preset)).toThrow(
      `${WEB_SEARCH_PACKAGE} ${WEB_SEARCH_VERSION} is installed without its pi-web-access-mcp bin`,
    );
    // Any other server still runs as `mcp.json` says.
    expect(programFor({ ...preset, args: ['-y', 'other-server'] })).toEqual({
      command: WEB_SEARCH_CONNECTION.command,
      args: ['-y', 'other-server'],
    });
  });
});
