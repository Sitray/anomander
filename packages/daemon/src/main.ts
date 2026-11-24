// Daemon entry point: reads the configuration (PRD §14.4), resolves the model through pi-ai
// (R-15 AC1) and starts the store, the front doors (Telegram while it is configured, the desktop
// app's local channel while `ANOMANDER_LOCAL_TOKEN` is set) and, while `ANOMANDER_API_TOKEN` is set,
// the read API (RA-2), or the setup guide while `.env` names no usable model (R-28). pi-ai reads the stored logins from `ANOMANDER_AUTH_PATH` on every
// request (R-15 AC3, R-27 AC5), or, under the desktop app, from `ANOMANDER_AUTH_JSON` (DK-5 AC1).
// The desktop app hands every secret over on stdin instead of the environment (DK-5 AC2).
import { type ExitCode, exitCodes } from '@anomander/protocol';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { startAnomander, startSetupGuide } from './app.ts';
import { createDeviceId } from './auth/device-id.ts';
import { rememberingLogins } from './auth/remembering-logins.ts';
import { credentialStoreFor } from './auth/shell-credential-store.ts';
import { loadConfig } from './config.ts';
import { printOAuthForShell } from './connections/oauth.ts';
import { exitOnceWritten, reportCrashes } from './crash.ts';
import { createScrubbingLogger } from './scrubbing-logger.ts';
import { createSecretList, secretsBeforeConfig, secretsToScrub } from './secrets-to-scrub.ts';
import { createConnectionGaps, resolveModels } from './setup/setup-guide.ts';
import { DaemonAlreadyRunningError } from './store/daemon-lock.ts';
import {
  handedAuthContext,
  readHandover,
  secretsOnStdin,
  stopsWithParent,
  stopWhenParentGoes,
} from './supervised.ts';

// Security audit M3: nothing the daemon writes holds a secret of its configuration, nor one it
// gets later (B42). Before the configuration is read, the environment's provider keys count.
const secrets = createSecretList();
secrets.setFromStart(secretsBeforeConfig(process.env));
const log = createScrubbingLogger(console, secrets.current);
// A crash is written through the same log, so its message and stack are scrubbed too, and the
// daemon exits once that line is out.
reportCrashes(
  process,
  log,
  exitOnceWritten([process.stdout, process.stderr], (code) => process.exit(code)),
);

// The exit code tells whoever started the daemon why it stopped (`exitCodes`).
const fail = (message: string, code: ExitCode = exitCodes.failed): never => {
  log.error(`anomander daemon failed: ${message}`);
  process.exit(code);
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

log.info('anomander daemon starting');

// DK-5 AC2: only the desktop app sets the flag; Docker and the CLI keep the environment. A handed
// value is read from here, never copied into `process.env`.
const handed = secretsOnStdin(process.env)
  ? await readHandover(process.stdin).catch((error: unknown) => fail(reason(error)))
  : {};

const env = { ...process.env, ...handed };
secrets.setFromStart(secretsBeforeConfig(env, handed));
const config = (() => {
  try {
    return loadConfig(env);
  } catch (error) {
    return fail(reason(error));
  }
})();
secrets.setFromStart(secretsToScrub(config, env));

// DK-5 AC1: the login the desktop app keeps in the Keychain, or the file of a Docker install.
const credentials = (() => {
  try {
    return rememberingLogins(credentialStoreFor(config), secrets.acquire);
  } catch (error) {
    return fail(reason(error));
  }
})();
const models = builtinModels({ credentials, authContext: handedAuthContext(handed, process.env) });
const resolved = resolveModels(config, (provider, id) => models.getModel(provider, id));
const login = {
  models: {
    login: (...args: Parameters<typeof models.login>) => models.login(...args),
    logout: (providerId: string) => models.logout(providerId),
  },
  credentials,
  getDeviceId: createDeviceId(config.authPath),
};

const anomander = (() => {
  try {
    if (!resolved.ready) {
      return startSetupGuide(config, { gaps: resolved.gaps, login, logger: log });
    }
    return startAnomander(config, {
      complete: (target, context, signal) =>
        models.complete(target, context, signal === undefined ? {} : { signal }),
      model: resolved.model,
      visionModel: resolved.visionModel,
      login,
      logger: log,
      printOAuth: (entries) => {
        secrets.acquire('oauth', entries);
        printOAuthForShell()(entries);
      },
      setupGaps: createConnectionGaps({
        providerIds: resolved.providerIds,
        checkAuth: (providerId) => models.checkAuth(providerId),
        logger: log,
      }),
    });
  } catch (error) {
    // DK-2 AC1: a second daemon on the same database refuses to start and says so.
    if (error instanceof DaemonAlreadyRunningError) {
      return fail(error.message, exitCodes.alreadyRunning);
    }
    return fail(`could not open the store at ${config.dbPath}: ${reason(error)}`);
  }
})();

anomander.started.then(
  () => {
    if (config.telegram !== undefined) log.info('anomander is listening on Telegram');
  },
  // Reported below, through `polling`.
  () => {},
);
// A daemon that no longer polls is deaf: it says why and exits instead of staying up. Only a
// daemon with Telegram polls, so only then is `@anomander/telegram` loaded to tell why.
anomander.polling.catch(async (error: unknown) => {
  const { isBotInUse } = await import('@anomander/telegram');
  return isBotInUse(error)
    ? // DK-2 AC2: another process, such as a Docker install, reads the same bot.
      fail('another ANOMANDER is using this Telegram bot (409 Conflict)', exitCodes.botInUse)
    : fail(`Telegram polling stopped: ${reason(error)}`);
});
// RA-2: logs the address only, never the token (AC2).
anomander.readApi?.then(
  ({ host, port }) => log.info(`anomander read API listening on ${host}:${port}`),
  (error) => fail(`read API could not listen: ${reason(error)}`),
);
// DK-3: logs the address only, never the token (AC2).
anomander.localChannel?.then(
  ({ host, port }) => log.info(`anomander local channel listening on ${host}:${port}`),
  (error) => fail(`local channel could not listen: ${reason(error)}`),
);

let stopping = false;
const stop = (cause: string): void => {
  if (stopping) return;
  stopping = true;
  log.info(`anomander daemon stopping (${cause})`);
  anomander.stop().then(
    () => log.info('anomander daemon stopped'),
    (error) => fail(`could not stop cleanly: ${reason(error)}`),
  );
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
// DK-1 AC1: under the desktop app, also when the app is gone without a signal.
if (stopsWithParent(process.env)) stopWhenParentGoes(process.stdin, () => stop('the app is gone'));
