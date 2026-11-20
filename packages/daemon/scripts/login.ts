// Model login from a terminal on the server (R-27 AC7): the same flows as `/login` in Telegram,
// stored in the same file, `ANOMANDER_AUTH_PATH`. The running daemon reads that file on every
// request, so it uses the login without a restart. The desktop app's daemon does not read it: the
// app takes a login left in its data folder into the Keychain at the daemon's next start (DK-5 AC1).
//
//   pnpm run login [openai | kimi-coding]
//
// `pnpm login` without `run` is pnpm's own npm-registry login. Run it from the directory the
// daemon runs in, so a relative `ANOMANDER_AUTH_PATH` names the same file. It prints links, device
// codes and the outcome; never a token.
//
// The desktop shell runs the same flows from its Suscripciones screen (DK-15):
//
//   node scripts/login.ts --shell <openai | kimi-coding>
//
// Then nothing is written to disk but the device ID (`<ANOMANDER_AUTH_PATH>.device-id`, not a
// secret): the credential goes to the shell on one line of stdout, `anomander login-done <json>`,
// an object by provider as `auth.json` holds it, which the shell keeps in the Keychain and never
// shows. Before it, `anomander login-open <address>` asks the shell to open the browser,
// `anomander login-code <code> <address>` gives it a device code to show and the page to open,
// and `anomander login-prompt` says the flow waits for the address the browser ended on, which
// the shell writes as one line on stdin. The run ends with one word, `connected`, `timed_out`
// or `cancelled`, and exit code 0. An error ends with 1 and prints only its kind on stderr: a
// message may quote the provider's answer. An account not offered ends with 2.
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { AuthInteraction, Credential, CredentialStore } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { createDeviceId } from '../src/auth/device-id.ts';
import { createFileCredentialStore } from '../src/auth/file-credential-store.ts';
import { LOGIN_ACCOUNTS, LOGIN_TIMEOUT_MS } from '../src/auth/telegram-login.ts';
import { loadAuthPath } from '../src/config.ts';

const authPath = resolve(process.env.INIT_CWD ?? process.cwd(), loadAuthPath(process.env));
const ids = LOGIN_ACCOUNTS.map(({ providerId }) => providerId);
const shellMode = process.argv[2] === '--shell';

if (shellMode) {
  const providerId = process.argv[3];
  if (providerId === undefined || !ids.includes(providerId)) {
    process.stderr.write(`usage: login --shell <${ids.join(' | ')}>\n`);
    process.exit(2);
  }
  await loginForShell(providerId);
} else {
  await loginFromTerminal();
}

/** DK-15: the login run by the desktop shell, which reads stdout and answers on stdin. */
async function loginForShell(providerId: string): Promise<never> {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  const controller = new AbortController();
  // R-27 AC4: a login not completed in this time is abandoned.
  const timer = setTimeout(() => controller.abort('timed_out'), LOGIN_TIMEOUT_MS);
  // The shell closes stdin, or dies, to cancel it.
  const rl = createInterface({ input: process.stdin });
  rl.on('close', () => controller.abort('cancelled'));

  // Nothing of the credential touches disk here: what the login stores is kept in memory and
  // handed to the shell once, at the end.
  const held = new Map<string, Credential>();
  const credentials: CredentialStore = {
    read: async (id) => held.get(id),
    list: async () => [...held].map(([id, { type }]) => ({ providerId: id, type })),
    modify: async (id, fn) => {
      const next = await fn(held.get(id));
      if (next !== undefined) held.set(id, next);
      return next ?? held.get(id);
    },
    delete: async (id) => {
      held.delete(id);
    },
  };

  const interaction: AuthInteraction = {
    signal: controller.signal,
    prompt: async (prompt) => {
      if (prompt.type !== 'manual_code' && prompt.type !== 'text') {
        // No flow offered here asks for a secret or a choice: the login fails.
        throw new Error(`unexpected ${prompt.type} prompt`);
      }
      // The shell shows a field for the address and writes what is pasted as one line. The
      // prompt's own signal ends the wait when the browser's callback arrives first.
      say('anomander login-prompt');
      const signal = prompt.signal
        ? AbortSignal.any([prompt.signal, controller.signal])
        : controller.signal;
      return (await rl.question('', { signal })).trim();
    },
    notify: (event) => {
      if (event.type === 'auth_url') say(`anomander login-open ${event.url}`);
      else if (event.type === 'device_code')
        say(`anomander login-code ${event.userCode} ${event.verificationUri}`);
    },
  };

  const models = builtinModels({ credentials });
  try {
    await models.login(providerId, 'oauth', interaction, { getDeviceId: createDeviceId(authPath) });
    const credential = held.get(providerId);
    if (credential === undefined) throw new Error('the login stored no credential');
    // One line, as `JSON.stringify` writes no line break.
    say(`anomander login-done ${JSON.stringify({ [providerId]: credential })}`);
    say('connected');
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      say(controller.signal.reason === 'timed_out' ? 'timed_out' : 'cancelled');
      process.exit(0);
    }
    // pi-ai's errors may quote a provider's response, so only the kind of failure is printed.
    process.stderr.write(`login failed: ${error instanceof Error ? error.name : 'Error'}\n`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
    rl.close();
  }
}

/** R-27 AC7: the login run by hand in a terminal. */
async function loginFromTerminal(): Promise<void> {
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
}
