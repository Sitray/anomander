import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createScrubbingLogger } from '../src/scrubbing-logger.ts';
import { secretsToScrub } from '../src/secrets-to-scrub.ts';

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
