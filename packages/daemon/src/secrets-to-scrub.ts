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

/**
 * The values of `ANOMANDER_MCP_SECRETS`, a JSON object of the Keychain items by name: the values
 * are secret, the names are not. When it is not such an object the connections use none of it
 * (`connections/config.ts`), yet it may still hold tokens, so the whole of it is secret.
 */
const mcpSecretValues = (raw: string | undefined): string[] => {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return Object.values(parsed).filter((value): value is string => typeof value === 'string');
    }
  } catch {
    // Not JSON: scrubbed whole, below.
  }
  return [raw];
};

/**
 * Every secret of `config` and of `env`, the environment with the handover laid over it as
 * `loadConfig` read it: the configuration's tokens, every model provider's key and every value of
 * `ANOMANDER_MCP_SECRETS`. A blank value is never one: it would match everywhere.
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
    ...mcpSecretValues(config.mcpSecrets),
  ].filter((secret): secret is string => secret !== undefined && secret.trim() !== '');
};
