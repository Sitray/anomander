// Daemon entry point: reads the configuration (PRD §14.4), resolves the model through pi-ai
// (R-15 AC1) and starts the store, the Telegram front door and, while `ANOMANDER_API_TOKEN` is set,
// the read API (RA-2), or the setup guide while `.env` names no usable model (R-28). pi-ai reads the stored logins from `ANOMANDER_AUTH_PATH` on every
// request (R-15 AC3, R-27 AC5).
import { type ExitCode, exitCodes } from '@anomander/protocol';
import { isBotInUse } from '@anomander/telegram';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { startAnomander, startSetupGuide } from './app.ts';
import { createDeviceId } from './auth/device-id.ts';
import { createFileCredentialStore } from './auth/file-credential-store.ts';
import { loadConfig } from './config.ts';
import { createConnectionGaps, resolveModels } from './setup/setup-guide.ts';
import { DaemonAlreadyRunningError } from './store/daemon-lock.ts';

// The exit code tells whoever started the daemon why it stopped (`exitCodes`).
const fail = (message: string, code: ExitCode = exitCodes.failed): never => {
  console.error(`anomander daemon failed: ${message}`);
  process.exit(code);
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

console.info('anomander daemon starting');

const config = (() => {
  try {
    return loadConfig(process.env);
  } catch (error) {
    return fail(reason(error));
  }
})();

const credentials = createFileCredentialStore(config.authPath);
const models = builtinModels({ credentials });
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
    if (!resolved.ready) return startSetupGuide(config, { gaps: resolved.gaps, login });
    return startAnomander(config, {
      complete: (target, context, signal) =>
        models.complete(target, context, signal === undefined ? {} : { signal }),
      model: resolved.model,
      visionModel: resolved.visionModel,
      login,
      setupGaps: createConnectionGaps({
        providerIds: resolved.providerIds,
        checkAuth: (providerId) => models.checkAuth(providerId),
        logger: console,
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
  () => console.info('anomander is listening on Telegram'),
  // Reported below, through `polling`.
  () => {},
);
// A daemon that no longer polls is deaf: it says why and exits instead of staying up.
anomander.polling.catch((error: unknown) =>
  isBotInUse(error)
    ? // DK-2 AC2: another process, such as a Docker install, reads the same bot.
      fail('another ANOMANDER is using this Telegram bot (409 Conflict)', exitCodes.botInUse)
    : fail(`Telegram polling stopped: ${reason(error)}`),
);
// RA-2: logs the address only, never the token (AC2).
anomander.readApi?.then(
  ({ host, port }) => console.info(`anomander read API listening on ${host}:${port}`),
  (error) => fail(`read API could not listen: ${reason(error)}`),
);
// DK-3: logs the address only, never the token (AC2).
anomander.localChannel?.then(
  ({ host, port }) => console.info(`anomander local channel listening on ${host}:${port}`),
  (error) => fail(`local channel could not listen: ${reason(error)}`),
);

const stop = (signal: NodeJS.Signals): void => {
  console.info(`anomander daemon stopping (${signal})`);
  anomander.stop().then(
    () => console.info('anomander daemon stopped'),
    (error) => fail(`could not stop cleanly: ${reason(error)}`),
  );
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
