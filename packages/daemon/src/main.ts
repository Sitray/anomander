// Daemon entry point: reads the configuration (PRD §14.4), resolves the model through pi-ai
// (R-15 AC1) and starts the store and the Telegram front door, or the setup guide while `.env`
// names no usable model (R-28). pi-ai reads the stored logins from `ANOMANDER_AUTH_PATH` on every
// request (R-15 AC3, R-27 AC5).
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { startAnomander, startSetupGuide } from './app.ts';
import { createDeviceId } from './auth/device-id.ts';
import { createFileCredentialStore } from './auth/file-credential-store.ts';
import { loadConfig } from './config.ts';
import { createConnectionGaps, resolveModels } from './setup/setup-guide.ts';

const fail = (message: string): never => {
  console.error(`anomander daemon failed to start: ${message}`);
  process.exit(1);
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
  if (!resolved.ready) return startSetupGuide(config, { gaps: resolved.gaps, login });
  try {
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
    return fail(`could not open the store at ${config.dbPath}: ${reason(error)}`);
  }
})();

anomander.started.then(
  () => console.info('anomander is listening on Telegram'),
  (error) => fail(`Telegram polling stopped: ${reason(error)}`),
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
