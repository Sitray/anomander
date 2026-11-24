// What the daemon's log never shows (security audit M3, B8). `scrubbing-logger.ts` takes them out
// of every line; this module only says which values they are.
import type { Config } from './config.ts';

/** A provider key as the desktop app names it, such as `OPENAI_API_KEY` (`setup.rs`). */
const PROVIDER_KEY = /^[A-Z][A-Z0-9_]*_API_KEY$/;

/** The other variables pi-ai reads a model provider's credential from (`env-api-keys.js`). */
const PROVIDER_CREDENTIALS = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'HF_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

/** Every string anywhere in `value`, however deep. */
const stringLeaves = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && value !== null)
    return Object.values(value).flatMap(stringLeaves);
  return [];
};

/**
 * The secrets of a variable that holds JSON: `ANOMANDER_MCP_SECRETS` (the Keychain items by name),
 * `ANOMANDER_AUTH_JSON` (the model login) and `ANOMANDER_MCP_OAUTH` (the connections' OAuth
 * clients and tokens). Every string in it, however deep, is one; the names are not. When it is
 * not JSON nothing reads it, yet it may still hold tokens, so the whole of it is one.
 */
const jsonSecrets = (raw: string | undefined): string[] => {
  if (raw === undefined) return [];
  try {
    return stringLeaves(JSON.parse(raw));
  } catch {
    return [raw];
  }
};

/**
 * Every secret of `config` and of `env`, the environment with the handover laid over it as
 * `loadConfig` read it: the configuration's tokens, every model provider's key, and every string of
 * `ANOMANDER_MCP_SECRETS`, the model login and the connections' OAuth tokens. A blank value is never one: it would match everywhere.
 */
export const secretsToScrub = (
  config: Config,
  env: Record<string, string | undefined>,
): string[] => {
  const providerKeys = Object.entries(env)
    .filter(([name]) => PROVIDER_KEY.test(name) || PROVIDER_CREDENTIALS.has(name))
    .map(([, value]) => value);
  return [
    config.telegram?.botToken,
    config.apiToken,
    config.localToken,
    ...providerKeys,
    ...jsonSecrets(config.mcpSecrets),
    ...jsonSecrets(config.authJson),
    ...jsonSecrets(config.mcpOAuth),
  ].filter((secret): secret is string => secret !== undefined && secret.trim() !== '');
};
