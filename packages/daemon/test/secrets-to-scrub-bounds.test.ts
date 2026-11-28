import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createScrubbingLogger } from '../src/scrubbing-logger.ts';
import {
  ACQUIRED_CEILING,
  ACQUIRED_KEPT_MS,
  ACQUIRED_LIMIT,
  createSecretList,
  secretsBeforeConfig,
  secretsToScrub,
} from '../src/secrets-to-scrub.ts';

// B53: the edges of the bound on acquired secrets (R4-unbounded-acquired-secrets) and of the
// tokens inside a handed JSON value before the configuration is read (R1-001).

/** The log `main.ts` builds over `list`, and what it wrote last. */
const logOver = (list: ReturnType<typeof createSecretList>) => {
  const lines: string[] = [];
  const sink = {
    info: (line: string) => lines.push(line),
    warn: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
  const logger = createScrubbingLogger(sink, list.current);
  return (text: string) => {
    logger.error(text);
    return lines.at(-1);
  };
};

/** `count` failures, each quoting a token of its own. */
const failuresQuoting = (list: ReturnType<typeof createSecretList>, count: number, tag: string) => {
  for (let index = 0; index < count; index += 1) {
    list.acquire('failure', new Error(`{"access_token":"${tag}-0123456789-${index}"}`));
  }
};

/** The connections' OAuth set, one server per entry of `tokens`, by its access token. */
const oauthSet = (tokens: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(tokens).map(([server, access]) => [
      server,
      {
        client: { client_id: 'c', client_secret: `${server}-client-secret-0123` },
        tokens: { access_token: access, refresh_token: `${access}-refresh` },
        redirectUrl: 'http://127.0.0.1/cb',
      },
    ]),
  );

describe('the bound on the secrets acquired after the start (B53)', () => {
  // B86: a secret seen within ACQUIRED_KEPT_MS is kept past ACQUIRED_LIMIT; these tests let a day
  // pass where a secret must be old enough to be dropped.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('never drops a secret of the start, however many are acquired', () => {
    const list = createSecretList();
    const start = ['bot-token-123456:ABCDEFGH', 'sk-proj-provider-key-0123', 'local-token-0123456'];
    list.setFromStart(start);
    failuresQuoting(list, 5 * ACQUIRED_LIMIT, 'x');
    const log = logOver(list);

    for (const secret of start) expect(log(`t ${secret}`)).toBe('t [secret]');
  });

  it('keeps every server of the current OAuth set when only another one refreshed', () => {
    const list = createSecretList();
    const log = logOver(list);
    list.acquire(
      'oauth',
      oauthSet({ notion: 'notion-a1-0123456789', github: 'github-g1-0123456789' }),
    );
    list.acquire(
      'oauth',
      oauthSet({ notion: 'notion-a2-0123456789', github: 'github-g1-0123456789' }),
    );
    vi.advanceTimersByTime(ACQUIRED_KEPT_MS);
    failuresQuoting(list, 3 * ACQUIRED_LIMIT, 'x');

    expect(log('github-g1-0123456789')).toBe('[secret]');
    expect(log('github-g1-0123456789-refresh')).toBe('[secret]');
    expect(log('github-client-secret-0123')).toBe('[secret]');
    expect(log('notion-a2-0123456789')).toBe('[secret]');
    // Rotated out a day ago, it is kept only until ACQUIRED_LIMIT newer ones came.
    expect(log('notion-a1-0123456789')).toBe('notion-a1-0123456789');
  });

  it('keeps hiding a rotated OAuth token until ACQUIRED_LIMIT newer ones came', () => {
    const list = createSecretList();
    const log = logOver(list);
    list.acquire('oauth', oauthSet({ notion: 'notion-a1-0123456789' }));
    list.acquire('oauth', oauthSet({ notion: 'notion-a2-0123456789' }));
    failuresQuoting(list, ACQUIRED_LIMIT - 10, 'x');

    expect(log('late error quoting notion-a1-0123456789')).toBe('late error quoting [secret]');
  });

  it('drops a login not read while ACQUIRED_LIMIT others came, and hides it again once read', () => {
    const list = createSecretList();
    const log = logOver(list);
    const login = {
      type: 'oauth',
      access: 'login-access-0123456789',
      refresh: 'login-refresh-0123456789',
    };
    list.acquire('login', login);
    vi.advanceTimersByTime(ACQUIRED_KEPT_MS);
    failuresQuoting(list, ACQUIRED_LIMIT, 'x');
    const dropped = log('login-access-0123456789');
    list.acquire('login', login);

    expect(dropped).toBe('login-access-0123456789');
    expect(log('login-access-0123456789')).toBe('[secret]');
  });

  it('stays bounded under churn and hides the newest', () => {
    const list = createSecretList();
    for (let index = 0; index < 2000; index += 1) {
      // A refresh of the connections and of the login every hour.
      vi.advanceTimersByTime(60 * 60 * 1000);
      list.acquire('oauth', oauthSet({ s: `s-${index}-0123456789` }));
      list.acquire('login', { access: `l-${index}-0123456789`, refresh: `r-${index}-0123456789` });
    }
    const log = logOver(list);

    expect(list.current().length).toBeLessThanOrEqual(ACQUIRED_LIMIT);
    expect(log('s-1999-0123456789 l-1999-0123456789 s-1999-0123456789-refresh')).toBe(
      '[secret] [secret] [secret]',
    );
  });
});

describe('the secrets acquired recently, kept past the bound (B86)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps hiding a rotated token seen within ACQUIRED_KEPT_MS however many newer came', () => {
    const list = createSecretList();
    const log = logOver(list);
    list.acquire('oauth', oauthSet({ notion: 'notion-a1-0123456789' }));
    list.acquire('oauth', oauthSet({ notion: 'notion-a2-0123456789' }));
    vi.advanceTimersByTime(ACQUIRED_KEPT_MS - 1);
    failuresQuoting(list, 3 * ACQUIRED_LIMIT, 'x');

    expect(log('late error quoting notion-a1-0123456789')).toBe('late error quoting [secret]');
  });

  it('drops it past ACQUIRED_LIMIT once ACQUIRED_KEPT_MS passed since it was seen', () => {
    const list = createSecretList();
    const log = logOver(list);
    list.acquire('oauth', oauthSet({ notion: 'notion-a1-0123456789' }));
    list.acquire('oauth', oauthSet({ notion: 'notion-a2-0123456789' }));
    failuresQuoting(list, ACQUIRED_LIMIT, 'early');
    vi.advanceTimersByTime(ACQUIRED_KEPT_MS);
    failuresQuoting(list, 1, 'late');

    // Past the floor the one seen longest ago goes first, as before; the current OAuth set never.
    expect(log('notion-a1-0123456789')).toBe('notion-a1-0123456789');
    expect(log('early-0123456789-0')).toBe('early-0123456789-0');
    expect(log(`early-0123456789-${ACQUIRED_LIMIT - 1} notion-a2-0123456789`)).toBe(
      '[secret] [secret]',
    );
    expect(log('late-0123456789-0')).toBe('[secret]');
    expect(list.current()).toHaveLength(ACQUIRED_LIMIT);
  });

  it('stays within ACQUIRED_CEILING under a flood of recent ones, keeping the start and the current OAuth set', () => {
    const list = createSecretList();
    const start = ['local-token-0123456789'];
    list.setFromStart(start);
    const log = logOver(list);
    list.acquire('oauth', oauthSet({ notion: 'notion-a1-0123456789' }));
    failuresQuoting(list, 2 * ACQUIRED_CEILING, 'flood');

    expect(list.current()).toHaveLength(start.length + ACQUIRED_CEILING);
    expect(log('notion-a1-0123456789 notion-a1-0123456789-refresh')).toBe('[secret] [secret]');
    expect(log('local-token-0123456789')).toBe('[secret]');
    expect(log(`flood-0123456789-${2 * ACQUIRED_CEILING - 1}`)).toBe('[secret]');
    expect(log('flood-0123456789-0')).toBe('flood-0123456789-0');
  });
});

describe('the secrets of a handed JSON value before the configuration is read (B53)', () => {
  const LOCAL_TOKEN = 'local-token-0123456789abcdef';
  const cases: Record<string, Record<string, string>> = {
    malformed: {
      ANOMANDER_MCP_SECRETS: '{"a": "secret-malformed-0123456',
      ANOMANDER_AUTH_JSON: '{not json',
      ANOMANDER_MCP_OAUTH: '[1,2',
    },
    nested: {
      ANOMANDER_MCP_SECRETS: JSON.stringify({
        a: ['nested-arr-0123456789', { b: { c: 'deep-0123456789' } }],
        n: 5,
        z: null,
      }),
      ANOMANDER_AUTH_JSON: JSON.stringify([
        { p: { access: 'arr-login-access-0123', token: 'odd-key-token-0123456' } },
      ]),
      ANOMANDER_MCP_OAUTH: JSON.stringify({
        s: { tokens: [{ access_token: 'arr-oauth-0123456789' }] },
      }),
    },
    scalars: {
      ANOMANDER_MCP_SECRETS: '"just-a-string-0123456"',
      ANOMANDER_AUTH_JSON: 'null',
      ANOMANDER_MCP_OAUTH: '42',
    },
    empty: { ANOMANDER_MCP_SECRETS: '', ANOMANDER_AUTH_JSON: '   ', ANOMANDER_MCP_OAUTH: '{}' },
  };

  for (const [name, values] of Object.entries(cases)) {
    it(`${name}: holds every secret the configuration will add`, () => {
      const handed = { ...values, ANOMANDER_LOCAL_TOKEN: LOCAL_TOKEN };
      const before = secretsBeforeConfig({}, handed);
      let after: string[] = [];
      try {
        after = secretsToScrub(loadConfig({ ...handed, ANOMANDER_DB_PATH: ':memory:' }), handed);
      } catch (error) {
        // A configuration it refuses says why without quoting a value.
        expect(String(error)).not.toMatch(/0123456/);
      }

      for (const secret of after) expect(before).toContain(secret);
    });
  }

  it('takes every value of a large handed JSON value', () => {
    const big = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, index) => [`k${index}`, `big-secret-${index}-0123456789`]),
    );

    const before = secretsBeforeConfig({}, { ANOMANDER_MCP_SECRETS: JSON.stringify(big) });

    expect(before).toHaveLength(20_001);
  });

  it('takes a handed JSON value too deep to walk whole, as one secret', () => {
    const deep = `${'['.repeat(20_000)}"deep-0123456789"${']'.repeat(20_000)}`;

    expect(secretsBeforeConfig({}, { ANOMANDER_MCP_SECRETS: deep })).toContain(deep);
  });
});
