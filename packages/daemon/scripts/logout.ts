// Model logout from a terminal on the server (R-27 AC7): deletes one account's credentials from
// `ANOMANDER_AUTH_PATH`, the file the daemon reads on every request.
//
//   pnpm run logout <anthropic | openai | github-copilot>
//
// `pnpm logout` without `run` is pnpm's own npm-registry logout. Run it from the directory the
// daemon runs in, so a relative `ANOMANDER_AUTH_PATH` names the same file.
import { resolve } from 'node:path';
import { createFileCredentialStore } from '../src/auth/file-credential-store.ts';
import { LOGIN_ACCOUNTS } from '../src/auth/telegram-login.ts';
import { loadAuthPath } from '../src/config.ts';

const authPath = resolve(process.env.INIT_CWD ?? process.cwd(), loadAuthPath(process.env));
const ids = LOGIN_ACCOUNTS.map(({ providerId }) => providerId);
const providerId = process.argv[2];

if (providerId === undefined || !ids.includes(providerId)) {
  console.error(`Usage: pnpm run logout <${ids.join(' | ')}>`);
  process.exit(1);
}

const store = createFileCredentialStore(authPath);
if ((await store.read(providerId)) === undefined) {
  console.info(`No account of ${providerId} is connected.`);
} else {
  await store.delete(providerId);
  console.info(`Logged out of ${providerId}.`);
}
