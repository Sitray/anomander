import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFileCredentialStore } from '../src/auth/file-credential-store.ts';
import { rememberingLogins } from '../src/auth/remembering-logins.ts';
import { createShellCredentialStore } from '../src/auth/shell-credential-store.ts';
import { loadConfig } from '../src/config.ts';
import { createOAuthKeeper } from '../src/connections/oauth.ts';
import { createScrubbingLogger } from '../src/scrubbing-logger.ts';
import {
  createSecretList,
  secretsBeforeConfig,
  secretsToScrub,
  secretTellingStores,
} from '../src/secrets-to-scrub.ts';

// B8: a Docker install's log is the daemon's own output; no key of its configuration may show.
const LOCAL_TOKEN = 'local-channel-token-0123456789abcdef';
const OPENAI_KEY = 'sk-proj-0123456789abcdefABCDEF';
const HF_TOKEN = 'hf_0123456789abcdefABCDEF';
const NOTES_TOKEN = 'notes-secret-0123456789abcdef';
const SEARCH_KEY = 'search-header-0123456789abcdef';
const LOGIN_KEY = 'sk-login-key-0123456789abcdef';
const LOGIN_REFRESH = 'login-refresh-0123456789abcdef';
const NOTION_ACCESS = 'notion-access-0123456789abcdef';
const NOTION_SECRET = 'notion-client-secret-0123456789';

/** What the daemon would write after `loadConfig(env)`, as `main.ts` builds its log. */
const logged = (env: Record<string, string | undefined>, message: string): string => {
  const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const secrets = secretsToScrub(loadConfig(env), env);
  createScrubbingLogger(sink, () => secrets).error(message);
  return String(sink.error.mock.calls[0]?.[0]);
};

describe('the secrets the daemon scrubs from its log', () => {
  it('include every provider key of the environment or the handover', () => {
    const line = logged(
      { ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN, OPENAI_API_KEY: OPENAI_KEY, HF_TOKEN },
      `request failed with Authorization: Bearer ${OPENAI_KEY} and ${HF_TOKEN}`,
    );

    expect(line).not.toContain(OPENAI_KEY);
    expect(line).not.toContain(HF_TOKEN);
    expect(line).toBe('request failed with Authorization: Bearer [secret] and [secret]');
  });

  it('include every value of ANOMANDER_MCP_SECRETS, but not its names', () => {
    const line = logged(
      {
        ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN,
        ANOMANDER_MCP_SECRETS: JSON.stringify({
          'mcp/notes/env/NOTES_TOKEN': NOTES_TOKEN,
          'mcp/search/headers/X-Api-Key': SEARCH_KEY,
        }),
      },
      `mcp/notes/env/NOTES_TOKEN was ${NOTES_TOKEN}, the header ${SEARCH_KEY}`,
    );

    expect(line).toBe('mcp/notes/env/NOTES_TOKEN was [secret], the header [secret]');
  });

  it('include every string of the model login, however deep', () => {
    const line = logged(
      {
        ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN,
        ANOMANDER_AUTH_JSON: JSON.stringify({
          openai: { type: 'api_key', key: LOGIN_KEY },
          'openai-codex': { type: 'oauth', expires: 1, tokens: [{ refresh: LOGIN_REFRESH }] },
        }),
      },
      `the login ${LOGIN_KEY} could not refresh with ${LOGIN_REFRESH}`,
    );

    expect(line).toBe('the login [secret] could not refresh with [secret]');
  });

  it("include every string of the connections' OAuth tokens, however deep", () => {
    const line = logged(
      {
        ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN,
        ANOMANDER_MCP_OAUTH: JSON.stringify({
          notion: {
            client: { client_secret: NOTION_SECRET },
            tokens: { access_token: NOTION_ACCESS },
          },
        }),
      },
      `notion answered 401 to ${NOTION_ACCESS} of the client ${NOTION_SECRET}`,
    );

    expect(line).toBe('notion answered 401 to [secret] of the client [secret]');
  });

  it('include the Bedrock bearer token pi-ai reads', () => {
    const t = 'bedrock-bearer-0123456789abcdef';
    expect(
      logged({ ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN, AWS_BEARER_TOKEN_BEDROCK: t }, `Bearer ${t}`),
    ).toBe('Bearer [secret]');
  });

  it('keep the OAuth client metadata visible', () => {
    const oauth = JSON.stringify({
      notes: {
        client: {
          client_id: 'c-1',
          client_name: 'ANOMANDER',
          grant_types: ['authorization_code', 'refresh_token'],
        },
        tokens: { access_token: NOTION_ACCESS, token_type: 'Bearer' },
        redirectUrl: 'http://127.0.0.1:54177/callback',
        url: 'https://notes.example/mcp',
      },
    });
    expect(
      logged(
        { ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN, ANOMANDER_MCP_OAUTH: oauth },
        `another ANOMANDER at https://notes.example/mcp ${NOTION_ACCESS}`,
      ),
    ).toBe('another ANOMANDER at https://notes.example/mcp [secret]');
  });

  it('keep the model login metadata visible', () => {
    const login = JSON.stringify({
      'github-copilot': {
        type: 'oauth',
        access: NOTION_ACCESS,
        refresh: LOGIN_REFRESH,
        expires: 1,
        enterpriseUrl: 'https://github.example.com',
      },
      'cloudflare-ai-gateway': {
        type: 'api_key',
        key: LOGIN_KEY,
        env: { CLOUDFLARE_ACCOUNT_ID: 'account-0123456789' },
      },
    });
    expect(
      logged(
        { ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN, ANOMANDER_AUTH_JSON: login },
        `https://github.example.com account-0123456789 ${NOTION_ACCESS} ${LOGIN_REFRESH} ${LOGIN_KEY}`,
      ),
    ).toBe('https://github.example.com account-0123456789 [secret] [secret] [secret]');
  });

  it("include the credentials of a login's env, by the same names as the environment's", () => {
    const awsSecret = 'aws-secret-0123456789abcdef';
    const login = JSON.stringify({
      'amazon-bedrock': {
        type: 'api_key',
        env: {
          AWS_ACCESS_KEY_ID: 'AKIA0123456789',
          AWS_SECRET_ACCESS_KEY: awsSecret,
          OPENAI_API_KEY: OPENAI_KEY,
        },
      },
    });
    expect(
      logged(
        { ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN, ANOMANDER_AUTH_JSON: login },
        `AKIA0123456789 ${awsSecret} ${OPENAI_KEY}`,
      ),
    ).toBe('AKIA0123456789 [secret] [secret]');
  });

  it('take the login or the OAuth tokens whole when they are not JSON', () => {
    const line = logged(
      {
        ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN,
        ANOMANDER_AUTH_JSON: `not json ${LOGIN_KEY}`,
        ANOMANDER_MCP_OAUTH: `not json ${NOTION_ACCESS}`,
      },
      `read not json ${LOGIN_KEY} and not json ${NOTION_ACCESS}`,
    );

    expect(line).toBe('read [secret] and [secret]');
  });

  it('never include an empty value', () => {
    const secrets = secretsToScrub(
      loadConfig({
        ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN,
        ANOMANDER_MCP_SECRETS: '{"mcp/a/env/T":""}',
        ANOMANDER_AUTH_JSON: '{"openai":{"type":"","key":" "}}',
        ANOMANDER_MCP_OAUTH: '{"notion":{"tokens":{"access_token":""}}}',
      }),
      { ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN, OPENAI_API_KEY: '', GEMINI_API_KEY: '  ' },
    );

    expect(secrets).toEqual([LOCAL_TOKEN]);
  });
});

// B42: what the daemon gets after its start (a refreshed or new login, a refreshed OAuth token)
// is scrubbed too, by the same rules as what it read at the start.
describe('the secrets the daemon gets after its start', () => {
  const NEW_ACCESS = 'late-access-0123456789abcdef';
  const NEW_REFRESH = 'late-refresh-0123456789abcdef';

  /** The log `main.ts` builds over `list`, and what it wrote last. */
  const logOver = (list: ReturnType<typeof createSecretList>) => {
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = createScrubbingLogger(sink, list.current);
    return (message: string): string => {
      logger.error(message);
      return String(sink.error.mock.calls.at(-1)?.[0]);
    };
  };

  it('include a login refreshed or made after the start', async () => {
    const list = createSecretList();
    list.setFromStart([LOCAL_TOKEN]);
    const log = logOver(list);
    const store = rememberingLogins(
      createShellCredentialStore('{}', () => {}),
      list.acquire,
    );

    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: NEW_ACCESS,
      refresh: NEW_REFRESH,
      expires: 1,
      accountId: 'account-0123456789',
    }));

    expect(log(`refresh of ${NEW_ACCESS} failed with ${NEW_REFRESH} for account-0123456789`)).toBe(
      'refresh of [secret] failed with [secret] for account-0123456789',
    );
    expect(log(`local ${LOCAL_TOKEN}`)).toBe('local [secret]');
  });

  /** A refresh that failed as pi-ai reports it: its own error, the provider's as its cause. */
  const failedRefresh = (cause: unknown) =>
    Object.assign(new Error('OAuth refresh failed for openai-codex', { cause }), {
      kind: 'oauth',
    });

  it('B51: include the tokens a failed refresh quotes in its cause, never stored', async () => {
    const list = createSecretList();
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = createScrubbingLogger(sink, list.current);
    const { credentials } = secretTellingStores(list, { authJson: '{}', authPath: '/nowhere' });
    // As `openai-codex.js` words a token response it cannot use.
    const body = { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, id_token: 'x' };
    const error = failedRefresh(
      new Error(`OpenAI Codex token refresh response missing fields: ${JSON.stringify(body)}`),
    );

    await expect(
      credentials.modify('openai-codex', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    logger.error('the model call failed', { error });

    const line = String(sink.error.mock.calls[0]?.[0]);
    expect(line).toContain('OpenAI Codex token refresh response missing fields');
    expect(line).not.toContain(NEW_ACCESS);
    expect(line).not.toContain(NEW_REFRESH);
    expect(await credentials.read('openai-codex')).toBeUndefined();
  });

  it('B51: include the tokens of a failed refresh whose cause holds them as fields', async () => {
    const list = createSecretList();
    const log = logOver(list);
    const store = rememberingLogins(
      createShellCredentialStore('{}', () => {}),
      list.acquire,
    );
    const cause = Object.assign(new Error('token response rejected'), {
      response: { tokens: { access: NEW_ACCESS, refresh: NEW_REFRESH } },
    });

    await expect(
      store.modify('anthropic', async () => {
        throw failedRefresh(cause);
      }),
    ).rejects.toThrow('OAuth refresh failed');

    expect(log(`401 for ${NEW_ACCESS} then ${NEW_REFRESH}`)).toBe('401 for [secret] then [secret]');
  });

  it("B82: keep a failed refresh's ordinary fields visible, such as the provider it names as `key`", async () => {
    const list = createSecretList();
    const log = logOver(list);
    const store = rememberingLogins(
      createShellCredentialStore('{}', () => {}),
      list.acquire,
    );
    const cause = Object.assign(new Error('token response rejected'), {
      key: 'openai-codex',
      env: { OPENAI_API_KEY: 'not-a-key-only-a-label' },
      response: { tokens: { access: NEW_ACCESS } },
    });

    await expect(
      store.modify('openai-codex', async () => {
        throw failedRefresh(cause);
      }),
    ).rejects.toThrow('OAuth refresh failed');

    expect(log('the model call to openai-codex failed')).toBe(
      'the model call to openai-codex failed',
    );
    expect(log('label not-a-key-only-a-label')).toBe('label not-a-key-only-a-label');
    expect(log(`401 for ${NEW_ACCESS}`)).toBe('401 for [secret]');
  });

  /** What the log shows of `error`, once `store.modify` failed with it. */
  const loggedAfterFailure = async (error: Error): Promise<string> => {
    const list = createSecretList();
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = createScrubbingLogger(sink, list.current);
    const store = rememberingLogins(
      createShellCredentialStore('{}', () => {}),
      list.acquire,
    );
    await expect(
      store.modify('anthropic', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    logger.error('the model call failed', { error });
    return String(sink.error.mock.calls[0]?.[0]);
  };

  it('B51: include a token a failed refresh quotes cut short, as in a body that is not JSON', async () => {
    // As pi-ai's `anthropic.js` words a token response it cannot parse, cut inside the token.
    const body = `{"access_token":"${NEW_ACCESS}","refresh_token":"${NEW_REFRESH.slice(0, 20)}`;
    const line = await loggedAfterFailure(
      failedRefresh(
        new Error(
          `Anthropic token refresh returned invalid JSON. url=https://example.test/token; body=${body}; details=SyntaxError: Unterminated string in JSON`,
        ),
      ),
    );

    expect(line).toContain('Anthropic token refresh returned invalid JSON');
    expect(line).toContain('details=SyntaxError');
    expect(line).not.toContain(NEW_ACCESS);
    expect(line).not.toContain(NEW_REFRESH.slice(0, 20));
  });

  it('B51: include the tokens a failed refresh quotes form-encoded', async () => {
    const id = 'late-id-token-0123456789abcdef';
    const line = await loggedAfterFailure(
      failedRefresh(
        new Error(
          `token response: access_token=${encodeURIComponent(NEW_ACCESS)}&refresh_token=${NEW_REFRESH}&id_token=${id}&token_type=bearer`,
        ),
      ),
    );

    expect(line).toContain('token_type=bearer');
    expect(line).not.toContain(NEW_ACCESS);
    expect(line).not.toContain(NEW_REFRESH);
    expect(line).not.toContain(id);
  });

  it('keep a short value a failed refresh quotes visible, as the start keeps one', async () => {
    const line = await loggedAfterFailure(
      failedRefresh(new Error('token response: {"access_token":"short"} and id_token=tiny')),
    );

    expect(line).toContain('"access_token":"short"');
    expect(line).toContain('id_token=tiny');
  });

  it('keep what a failed refresh says visible when it quotes no token', async () => {
    const list = createSecretList();
    const log = logOver(list);
    const store = rememberingLogins(
      createShellCredentialStore('{}', () => {}),
      list.acquire,
    );
    const error = failedRefresh(
      new Error('invalid_grant: {"error":"invalid_grant","account":"account-0123456789"}'),
    );

    await expect(
      store.modify('openai-codex', async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(list.current()).toEqual([]);
    expect(log('invalid_grant for account-0123456789')).toBe(
      'invalid_grant for account-0123456789',
    );
  });

  it('include a login another process wrote to the file after the start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anomander-late-login-'));
    try {
      const path = join(dir, 'auth.json');
      const list = createSecretList();
      const log = logOver(list);
      const store = rememberingLogins(createFileCredentialStore(path), list.acquire);
      writeFileSync(path, JSON.stringify({ openai: { type: 'api_key', key: LOGIN_KEY } }));

      await store.read('openai');

      expect(log(`401 for ${LOGIN_KEY}`)).toBe('401 for [secret]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("include a connection's OAuth tokens refreshed after the start", () => {
    const list = createSecretList();
    const log = logOver(list);
    const keeper = createOAuthKeeper(
      {
        notion: {
          client: { client_id: 'c-1' },
          tokens: { access_token: NOTION_ACCESS, token_type: 'Bearer' },
          redirectUrl: 'http://127.0.0.1:54177/callback',
          url: 'https://notion.example/mcp',
        },
      },
      (entries) => list.acquire('oauth', entries),
    );

    keeper
      .providerFor('notion', 'https://notion.example/mcp')
      ?.saveTokens({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, token_type: 'Bearer' });

    expect(log(`https://notion.example/mcp refused ${NEW_ACCESS} and ${NEW_REFRESH}`)).toBe(
      'https://notion.example/mcp refused [secret] and [secret]',
    );
  });

  it('come from the stores main.ts hands the daemon: the login and the OAuth printer', async () => {
    const list = createSecretList();
    const log = logOver(list);
    const out: string[] = [];
    const { credentials, printOAuth } = secretTellingStores(
      list,
      { authJson: '{}', authPath: '/nowhere/auth.json' },
      (text) => out.push(text),
    );

    await credentials.modify('openai', async () => ({ type: 'api_key', key: LOGIN_KEY }));
    printOAuth({
      notion: {
        client: { client_id: 'c-1' },
        tokens: { access_token: NEW_ACCESS, token_type: 'Bearer' },
        redirectUrl: 'http://127.0.0.1:54177/callback',
      },
    });

    expect(log(`401 for ${LOGIN_KEY} and ${NEW_ACCESS}`)).toBe('401 for [secret] and [secret]');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^anomander credentials /);
    expect(out[1]).toMatch(/^anomander mcp-oauth .*late-access/);
  });

  it('keeps logging when a secret holds a lone surrogate', () => {
    const list = createSecretList();
    list.acquire('oauth', JSON.parse('{"access_token":"abcdefgh\\ud800ijkl"}'));
    const lines: string[] = [];
    const sink = { info: (m: string) => lines.push(m), warn: () => {}, error: () => {} };
    const log = createScrubbingLogger(sink, list.current);

    expect(() => log.info('anomander daemon stopping (SIGTERM)')).not.toThrow();
    expect(lines).toEqual(['anomander daemon stopping (SIGTERM)']);
  });

  it('include, before the configuration is read, every provider key and every handed value', () => {
    expect(
      secretsBeforeConfig(
        { OPENAI_API_KEY: OPENAI_KEY, HOME: '/home/someone-long' },
        {
          ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN,
          OPENAI_API_KEY: OPENAI_KEY,
          ANOMANDER_MCP_SECRETS: '',
        },
      ),
    ).toEqual([OPENAI_KEY, LOCAL_TOKEN]);
  });
});
