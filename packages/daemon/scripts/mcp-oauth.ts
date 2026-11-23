// DK-11 OAuth: connects the app to an MCP server reached over HTTP that asks for OAuth, run by the
// desktop shell from the connections screen.
//
//   node scripts/mcp-oauth.ts <url>
//
// Prints `anomander oauth-open <address>` for the shell to open in the browser, then, once the
// principal authorized the app, `anomander oauth-done <json>` with the client and its tokens on
// one line, which the shell stores in the Keychain and never shows. Then one word: `connected`,
// `denied` or `timed_out`, and ends with 0. An error ends with 1 and prints only its code: a
// message may quote the address. Without an `http` or `https` address it ends with 2. The page the
// browser shows at the end speaks `ANOMANDER_LOCALE`, which the shell passes on.
import { setLocale } from '@anomander/protocol';
import { loadLocale } from '../src/config.ts';
import { connectWithOAuth } from '../src/connections/oauth-login.ts';

setLocale(loadLocale(process.env));

const [url] = process.argv.slice(2);
const isAddress = (text: string | undefined): text is string => {
  if (text === undefined || !URL.canParse(text)) return false;
  return ['http:', 'https:'].includes(new URL(text).protocol);
};
if (!isAddress(url)) {
  console.error('usage: mcp-oauth <http or https address>');
  process.exit(2);
}
try {
  const outcome = await connectWithOAuth({
    url,
    open: async (address) => {
      process.stdout.write(`anomander oauth-open ${address}\n`);
    },
  });
  if (outcome.kind === 'connected') {
    process.stdout.write(`anomander oauth-done ${JSON.stringify(outcome.entry)}\n`);
  }
  process.stdout.write(`${outcome.kind}\n`);
  process.exit(0);
} catch (error) {
  const { code, name, cause } = error as { code?: unknown; name?: unknown; cause?: unknown };
  const reason = (cause as { code?: unknown } | undefined)?.code ?? code ?? name;
  process.stderr.write(`could not connect with OAuth: ${String(reason)}\n`);
  process.exit(1);
}
