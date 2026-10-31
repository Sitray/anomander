// Daemon entry point: reads the configuration (PRD §14.4), resolves the model through pi-ai
// (R-15 AC1) and starts the store and the Telegram front door.
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { startAnomander } from './app.ts';
import { loadConfig } from './config.ts';

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

const models = builtinModels();
const model =
  models.getModel(config.model.provider, config.model.id) ??
  fail(`unknown model ${config.model.provider}/${config.model.id} (ANOMANDER_MODEL)`);
const visionModel =
  models.getModel(config.visionModel.provider, config.visionModel.id) ??
  fail(
    `unknown model ${config.visionModel.provider}/${config.visionModel.id} (ANOMANDER_VISION_MODEL)`,
  );

const anomander = (() => {
  try {
    return startAnomander(config, {
      complete: (target, context, signal) =>
        models.complete(target, context, signal === undefined ? {} : { signal }),
      model,
      visionModel,
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
