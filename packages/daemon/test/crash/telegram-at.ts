// Preloaded into `main.ts` with `--import` by `test/desktop/main-crash.test.ts`, beside
// `fixtures/crash-after-start.ts`. `main.ts` takes no Bot API address: the bot always calls
// `https://api.telegram.org`. This sends those calls to `ANOMANDER_TEST_TELEGRAM_API_ROOT`, a
// plain `http://` server of the test, such as the fake Bot API, and leaves every other call alone.
// grammY sends through `node-fetch`, which calls `https.request` with the parsed address.
import http from 'node:http';
import https from 'node:https';

const root = process.env.ANOMANDER_TEST_TELEGRAM_API_ROOT;

if (root !== undefined && root !== '') {
  const target = new URL(root);
  const request = https.request;
  const toTelegram = (options: unknown): options is Record<string, unknown> =>
    typeof options === 'object' &&
    options !== null &&
    !(options instanceof URL) &&
    (options as { hostname?: unknown }).hostname === 'api.telegram.org';
  https.request = ((options: unknown, ...rest: unknown[]) => {
    if (!toTelegram(options)) return (request as (...args: unknown[]) => unknown)(options, ...rest);
    // The https agent cannot carry a plain http request; the address is the test's.
    const { agent: _agent, host: _host, ...kept } = options;
    return (http.request as (...args: unknown[]) => unknown)(
      { ...kept, protocol: 'http:', hostname: target.hostname, port: target.port },
      ...rest,
    );
  }) as typeof https.request;
}
