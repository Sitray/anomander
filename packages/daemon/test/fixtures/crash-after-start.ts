// Preloaded into `main.ts` with `--import` by `test/desktop/main-crash.test.ts`. Once the daemon
// says its local channel listens, so its configuration and its secrets are loaded, it crashes as
// `ANOMANDER_TEST_CRASH` says: `exception` throws, `rejection` leaves a promise rejected. The
// error's message is `ANOMANDER_TEST_CRASH_MESSAGE`.
const how = process.env.ANOMANDER_TEST_CRASH;
const message = process.env.ANOMANDER_TEST_CRASH_MESSAGE ?? 'crash';

const crash = (): void => {
  if (how === 'exception') throw new Error(message);
  void Promise.reject(new Error(message));
};

const info = console.info.bind(console);
console.info = (...args: unknown[]): void => {
  info(...args);
  if (String(args[0]).includes('local channel listening')) setImmediate(crash);
};
