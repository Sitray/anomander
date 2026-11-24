// Preloaded into `main.ts` with `--import` by `test/desktop/main-crash.test.ts`. Once the daemon
// says its local channel listens, so its configuration and its secrets are loaded, it crashes as
// `ANOMANDER_TEST_CRASH` says: `exception` throws, `rejection` leaves a promise rejected. The
// error's message is `ANOMANDER_TEST_CRASH_MESSAGE`. `ANOMANDER_TEST_CRASH_AFTER` names another
// line to crash after instead, and `ANOMANDER_TEST_CRASH_FLOOD` a number of bytes written to stderr
// just before, so the crash line waits behind them in a full pipe.
const how = process.env.ANOMANDER_TEST_CRASH;
const message = process.env.ANOMANDER_TEST_CRASH_MESSAGE ?? 'crash';
const after = process.env.ANOMANDER_TEST_CRASH_AFTER ?? 'local channel listening';
const flood = Number(process.env.ANOMANDER_TEST_CRASH_FLOOD ?? 0);

const crash = (): void => {
  if (flood > 0) process.stderr.write(`${'.'.repeat(flood)}\n`);
  if (how === 'exception') throw new Error(message);
  void Promise.reject(new Error(message));
};

const info = console.info.bind(console);
console.info = (...args: unknown[]): void => {
  info(...args);
  if (String(args[0]).includes(after)) setImmediate(crash);
};
