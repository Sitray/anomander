// The daemon's log with its secrets taken out (security audit M3). An error from Telegram keeps
// the address it was sent to, `https://api.telegram.org/bot<token>/…`, deep in its fields, and the
// console prints the whole of it. The desktop app scrubs what it forwards (`daemon/output.rs`);
// a Docker or terminal install reads the daemon's own output, so the daemon scrubs it too.
import { format } from 'node:util';
import type { TelegramLogger } from '@anomander/telegram';

/** What a secret is replaced with, as `REDACTED` of the desktop app's `output.rs`. */
export const REDACTED = '[secret]';

/** A bot token in a Bot API address, known or not: `bot<id>:<secret>`. */
const BOT_TOKEN_IN_ADDRESS = /\bbot\d+:[\w-]+/g;

/**
 * A shorter secret is left alone: replacing it would garble every line it happens to appear in
 * (an `ANOMANDER_API_TOKEN` of `1` would take the digits out of every address and port).
 */
const SHORTEST_SECRET = 8;

/**
 * `secret` as a line may quote it (B42): as it is, escaped inside a JSON string (a request body),
 * and URL-encoded in an address or in a form, where a space is `+`.
 */
const writtenForms = (secret: string): string[] => [
  ...new Set([
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    new URLSearchParams({ s: secret }).toString().slice(2),
  ]),
];

/**
 * `text` with every secret of `SHORTEST_SECRET` or more replaced whole, in each of its written
 * forms, the longest first.
 */
export const scrub = (text: string, secrets: readonly string[]): string => {
  const known = secrets
    .filter((secret) => secret.length >= SHORTEST_SECRET)
    .flatMap(writtenForms)
    .sort((a, b) => b.length - a.length);
  const scrubbed = known.reduce((line, secret) => line.replaceAll(secret, REDACTED), text);
  return scrubbed.replace(BOT_TOKEN_IN_ADDRESS, `bot${REDACTED}`);
};

/**
 * Writes to `sink` each line as the console would format it, scrubbed of `secrets()`: read at
 * each line, so the secrets of a configuration loaded later count too.
 */
export const createScrubbingLogger = (
  sink: TelegramLogger,
  secrets: () => readonly string[],
): TelegramLogger => {
  const line = (message: string, fields?: Record<string, unknown>) =>
    scrub(fields === undefined ? format(message) : format(message, fields), secrets());
  return {
    info: (message, fields) => sink.info(line(message, fields)),
    warn: (message, fields) => sink.warn(line(message, fields)),
    error: (message, fields) => sink.error(line(message, fields)),
  };
};
