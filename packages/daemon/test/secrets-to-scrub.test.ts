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

  it('never include an empty value', () => {
    const secrets = secretsToScrub(
      loadConfig({
        ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN,
        ANOMANDER_MCP_SECRETS: '{"mcp/a/env/T":""}',
      }),
      { ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN, OPENAI_API_KEY: '', GEMINI_API_KEY: '  ' },
    );

    expect(secrets).toEqual([LOCAL_TOKEN]);
  });
});
