import { describe, expect, it, vi } from 'vitest';
import { connectTo, createConnections, transportFor } from '../../src/connections/mcp-client.ts';
import {
  createOAuthKeeper,
  MCP_OAUTH_LINE,
  type OAuthEntry,
  oauthKeeperFrom,
  originScopedFetch,
  printOAuthForShell,
} from '../../src/connections/oauth.ts';
import { connectWithOAuth } from '../../src/connections/oauth-login.ts';
import { authorize, startOAuthServer } from '../fixtures/oauth-server.ts';

// DK-11 OAuth: the daemon connects with the tokens the app keeps in the Keychain, and hands every
// refresh back to it. It never opens a browser.

const ENTRY: OAuthEntry = {
  client: { client_id: 'client-1', redirect_uris: ['http://127.0.0.1:50000/callback'] },
  tokens: { access_token: 'access-secret', token_type: 'Bearer', refresh_token: 'refresh-secret' },
  redirectUrl: 'http://127.0.0.1:50000/callback',
  url: 'https://notes.example/mcp',
};
const NOTES = 'https://notes.example/mcp';

const keeper = (initial: Record<string, OAuthEntry> = { notes: ENTRY }) => {
  const sent: unknown[] = [];
  return { sent, keeper: createOAuthKeeper(initial, (entries) => sent.push(entries)) };
};

describe('the tokens the app keeps', () => {
  it('gives a provider only for a server that has tokens', async () => {
    const { keeper: kept } = keeper();
    expect(kept.providerFor('other', NOTES)).toBeUndefined();
    const provider = kept.providerFor('notes', NOTES);
    expect(await provider?.tokens()).toEqual(ENTRY.tokens);
    expect(await provider?.clientInformation()).toEqual(ENTRY.client);
    expect(provider?.redirectUrl).toBe(ENTRY.redirectUrl);
    expect(provider?.clientMetadata.redirect_uris).toEqual([ENTRY.redirectUrl]);
  });

  it('gives none for another address than the one the tokens were given for', () => {
    const { keeper: kept } = keeper();
    expect(kept.providerFor('notes', 'https://elsewhere.example/mcp')).toBeUndefined();
    const { url: _url, ...without } = ENTRY;
    expect(
      createOAuthKeeper({ notes: without }, () => {}).providerFor('notes', NOTES),
    ).toBeUndefined();
  });

  it('hands the whole set back after a refresh, before it answers', async () => {
    const other = { ...ENTRY, tokens: { access_token: 'a-2', token_type: 'Bearer' } };
    const notes = { ...ENTRY, label: 'kept as it is' } as OAuthEntry;
    const { sent, keeper: kept } = keeper({ notes, other });
    const provider = kept.providerFor('notes', NOTES);
    const rotated = { access_token: 'access-2', token_type: 'Bearer', refresh_token: 'refresh-2' };

    await provider?.saveTokens(rotated);

    // What the app keeps beside the tokens comes back as it was.
    expect(sent).toEqual([{ notes: { ...notes, tokens: rotated }, other }]);
    expect(await kept.providerFor('notes', NOTES)?.tokens()).toEqual(rotated);
  });

  it('forgets a server whose tokens the authorization server refused', async () => {
    const { sent, keeper: kept } = keeper();
    await kept.providerFor('notes', NOTES)?.invalidateCredentials?.('tokens');
    expect(sent).toEqual([{}]);
    expect(kept.providerFor('notes', NOTES)).toBeUndefined();
  });

  it('never opens a browser, and hands nothing back for it', async () => {
    const { sent, keeper: kept } = keeper();
    const provider = kept.providerFor('notes', NOTES);
    await expect(
      Promise.resolve().then(() => provider?.redirectToAuthorization(new URL('https://a.example'))),
    ).rejects.toThrow('connect the server with OAuth again in the app');
    expect(sent).toEqual([]);
  });

  it('prints the set for the shell on one line', () => {
    const written: string[] = [];
    printOAuthForShell((text) => written.push(text))({ notes: ENTRY });
    expect(written).toEqual([`${MCP_OAUTH_LINE}${JSON.stringify({ notes: ENTRY })}\n`]);
    expect(MCP_OAUTH_LINE).toBe('anomander mcp-oauth ');
  });

  it('reads what the app handed over, and starts empty from what is not a set', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(
      oauthKeeperFrom(JSON.stringify({ notes: ENTRY }), () => {}, logger).providerFor(
        'notes',
        NOTES,
      ),
    ).toBeDefined();
    for (const handed of ['not json access-secret', '[1]', '{"notes":{"tokens":1}}']) {
      expect(oauthKeeperFrom(handed, () => {}, logger).providerFor('notes', NOTES)).toBeUndefined();
    }
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('access-secret');
    expect(
      oauthKeeperFrom(undefined, () => {}, logger).providerFor('notes', NOTES),
    ).toBeUndefined();
  });
});

describe('the headers of a server', () => {
  it('go to its own origin only', async () => {
    const base = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('ok'));
    const scoped = originScopedFetch('https://notes.example/mcp', { 'X-Key': 'k-secret' }, base);

    await scoped('https://notes.example/other', { headers: { Accept: 'x' } });
    await scoped(new URL('https://auth.example/token'), { headers: { Accept: 'y' } });
    await scoped('http://notes.example/mcp');

    expect(base.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-key'))).toEqual([
      'k-secret',
      null,
      null,
    ]);
    expect(new Headers(base.mock.calls[0]?.[1]?.headers).get('accept')).toBe('x');
  });
});

describe('a server connected with OAuth', () => {
  const connected = async (separateOrigin = false) => {
    const fixture = await startOAuthServer({ separateOrigin });
    const login = await connectWithOAuth({
      url: fixture.mcpUrl,
      open: async (address) => {
        await authorize(address);
      },
    });
    if (login.kind !== 'connected') throw new Error(login.kind);
    return { fixture, entry: login.entry };
  };

  it('is reached with its tokens', async () => {
    const { fixture, entry } = await connected();
    const { keeper: kept } = keeper({ remote: { ...entry, url: fixture.mcpUrl } });
    const transport = transportFor(
      { kind: 'http', url: fixture.mcpUrl, headers: {}, readOnly: [] },
      kept.providerFor('remote', fixture.mcpUrl),
    );

    const { connection, close } = await connectTo('remote', [], transport);
    expect(await connection.call('search', { query: 'Lisboa' })).toMatchObject({
      text: 'found: Lisboa',
    });
    await close();
    await fixture.close();
  });

  it('refreshes an expired token and hands the new ones to the shell', async () => {
    const { fixture, entry } = await connected();
    const { sent, keeper: kept } = keeper({ remote: { ...entry, url: fixture.mcpUrl } });
    fixture.expireAccess();

    const transport = transportFor(
      { kind: 'http', url: fixture.mcpUrl, headers: {}, readOnly: [] },
      kept.providerFor('remote', fixture.mcpUrl),
    );
    const { close } = await connectTo('remote', [], transport);
    await close();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      remote: { tokens: { access_token: fixture.access(), refresh_token: fixture.refresh() } },
    });
    await fixture.close();
  });

  it('is left out, with no browser, once its refresh token is refused', async () => {
    const { fixture, entry } = await connected();
    const { keeper: kept } = keeper({ remote: { ...entry, url: fixture.mcpUrl } });
    fixture.expireAccess();
    fixture.revokeRefresh();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const connections = createConnections({
      config: { remote: { kind: 'http', url: fixture.mcpUrl, headers: {}, readOnly: [] } },
      logger,
      oauth: kept,
    });

    expect(await connections.get()).toEqual([]);
    expect(connections.unreachable()).toEqual(['remote']);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('access-');
    await connections.close();
    await fixture.close();
  });

  it('never sends its tokens to a server at another address', async () => {
    const { fixture, entry } = await connected();
    const { keeper: kept } = keeper({ remote: { ...entry, url: 'https://notes.example/mcp' } });
    fixture.seen.length = 0;
    const connections = createConnections({
      config: { remote: { kind: 'http', url: fixture.mcpUrl, headers: {}, readOnly: [] } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      oauth: kept,
    });

    expect(await connections.get()).toEqual([]);
    expect(
      fixture.seen.some((request) =>
        request.headers.authorization?.includes(entry.tokens.access_token),
      ),
    ).toBe(false);
    await connections.close();
    await fixture.close();
  });

  it('sends the configured headers to the server, never to its authorization server', async () => {
    const { fixture, entry } = await connected(true);
    const { keeper: kept } = keeper({ remote: { ...entry, url: fixture.mcpUrl } });
    fixture.expireAccess();
    fixture.seen.length = 0;

    const transport = transportFor(
      { kind: 'http', url: fixture.mcpUrl, headers: { 'X-Key': 'k-secret' }, readOnly: [] },
      kept.providerFor('remote', fixture.mcpUrl),
    );
    const { close } = await connectTo('remote', [], transport);
    await close();

    const auth = fixture.seen.filter((request) => request.origin === 'auth');
    expect(auth.some((request) => request.path === '/token')).toBe(true);
    expect(auth.every((request) => request.headers['x-key'] === undefined)).toBe(true);
    const mcp = fixture.seen.filter(
      (request) => request.origin === 'mcp' && request.path === '/mcp',
    );
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp.every((request) => request.headers['x-key'] === 'k-secret')).toBe(true);
    await fixture.close();
  });
});
