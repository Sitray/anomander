// Model login from a terminal on the server (R-27 AC7): the same flows as `/login` in Telegram,
// stored in the same file, `ANOMANDER_AUTH_PATH`. The running daemon reads that file on every
// request, so it uses the login without a restart.
//
//   pnpm run login [anthropic | openai | github-copilot]
//
// `pnpm login` without `run` is pnpm's own npm-registry login. Run it from the directory the
// daemon runs in, so a relative `ANOMANDER_AUTH_PATH` names the same file. It prints links, device
// codes and the outcome; never a token.
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { createDeviceId } from '../src/auth/device-id.ts';
import { createFileCredentialStore } from '../src/auth/file-credential-store.ts';
import { LOGIN_ACCOUNTS } from '../src/auth/telegram-login.ts';
import { loadAuthPath } from '../src/config.ts';

const authPath = resolve(process.env.INIT_CWD ?? process.cwd(), loadAuthPath(process.env));
const ids = LOGIN_ACCOUNTS.map(({ providerId }) => providerId);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const controller = new AbortController();
// Ctrl+C, or the end of the input, cancels the login.
rl.on('SIGINT', () => controller.abort());
rl.on('close', () => controller.abort());

const fail = (message: string): never => {
  console.error(message);
  rl.close();
  process.exit(1);
};

/** Asks until the answer is a number from the list or one of its IDs. */
const choose = async (message: string, options: readonly { id: string; label: string }[]) => {
  console.info(message);
  options.forEach(({ label, id }, i) => {
    console.info(`  ${i + 1}. ${label} (${id})`);
  });
  for (;;) {
    const answer = (await rl.question('> ', { signal: controller.signal })).trim();
    const picked = options[Number(answer) - 1] ?? options.find(({ id }) => id === answer);
    if (picked !== undefined) return picked.id;
  }
};

const providerId =
  process.argv[2] ??
  (await choose(
    'Which account?',
    LOGIN_ACCOUNTS.map(({ providerId: id, label }) => ({ id, label })),
  ));
if (!ids.includes(providerId))
  fail(`Unknown account ${providerId}. Use one of: ${ids.join(', ')}.`);

const interaction: AuthInteraction = {
  signal: controller.signal,
  prompt: async (prompt) => {
    if (prompt.type === 'select') return choose(prompt.message, prompt.options);
    if (prompt.type === 'secret')
      throw new Error('this login asks for a secret; it is not supported');
    const signal = prompt.signal
      ? AbortSignal.any([prompt.signal, controller.signal])
      : controller.signal;
    return rl.question(`${prompt.message} `, { signal });
  },
  notify: (event) => {
    if (event.type === 'auth_url') {
      console.info(`\nOpen this link:\n${event.url}\n`);
      if (event.instructions) console.info(event.instructions);
    } else if (event.type === 'device_code') {
      console.info(`\nOpen ${event.verificationUri} and enter the code ${event.userCode}\n`);
    } else if (event.type === 'info') {
      console.info(event.message);
      for (const link of event.links ?? []) console.info(`${link.label ?? 'Link'}: ${link.url}`);
    } else {
      console.info(event.message);
    }
  },
};

const models = builtinModels({ credentials: createFileCredentialStore(authPath) });
try {
  await models.login(providerId, 'oauth', interaction, { getDeviceId: createDeviceId(authPath) });
  console.info(`Logged in to ${providerId}. Credentials saved to ${authPath}.`);
} catch (error) {
  // pi-ai's errors may quote a provider's response, so only the kind of failure is printed.
  fail(
    controller.signal.aborted
      ? 'Login cancelled.'
      : `Login to ${providerId} failed${error instanceof Error ? ` (${error.name})` : ''}.`,
  );
}
rl.close();
