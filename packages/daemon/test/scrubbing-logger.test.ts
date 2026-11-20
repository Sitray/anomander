import { describe, expect, it, vi } from 'vitest';
import { createScrubbingLogger } from '../src/scrubbing-logger.ts';

const TOKEN = '7123456789:AAHf3kE9xQ_zT-1bc2De3Fg4Hi5Jk6Lm7No';
const sink = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

// grammY's HttpError keeps the fetch error, whose message holds the request's address, and with
// it the bot's token.
const networkError = () =>
  Object.assign(new Error("Network request for 'getUpdates' failed!"), {
    error: new Error(
      `request to https://api.telegram.org/bot${TOKEN}/getUpdates failed, reason: ECONNRESET`,
    ),
  });

describe('the scrubbing logger', () => {
  it('never writes a known secret, however deep in the fields it is', () => {
    const out = sink();
    const logger = createScrubbingLogger(out, () => [TOKEN, 'local-token-123']);

    logger.error('Failed to handle a Telegram update', { updateId: 7, error: networkError() });
    logger.warn('the local channel refused local-token-123');

    const [line] = out.error.mock.calls[0] ?? [];
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain('AAHf3kE9xQ');
    expect(line).toContain('https://api.telegram.org/bot[secret]/getUpdates');
    expect(line).toContain('Failed to handle a Telegram update');
    expect(line).toContain('updateId: 7');
    expect(out.warn).toHaveBeenCalledWith('the local channel refused [secret]');
  });

  it('hides a bot token in an address even when it is not one it knows', () => {
    const out = sink();
    const logger = createScrubbingLogger(out, () => []);

    logger.error('polling stopped', { error: networkError() });

    expect(out.error.mock.calls[0]?.[0]).not.toContain(TOKEN);
    expect(out.error.mock.calls[0]?.[0]).toContain('bot[secret]/getUpdates');
  });

  it('leaves the lines whole when a secret is too short to tell from other text', () => {
    const out = sink();
    const logger = createScrubbingLogger(out, () => ['1', 'abc']);

    logger.info('anomander local channel listening on 127.0.0.1:51234');

    expect(out.info).toHaveBeenCalledWith('anomander local channel listening on 127.0.0.1:51234');
  });

  it('writes everything else as the console would', () => {
    const out = sink();
    const logger = createScrubbingLogger(out, () => [TOKEN, '']);

    logger.info('anomander store ready at /data/anomander.db (3 migrations applied)');
    logger.warn('computer planning failed', { reason: 'processor stopped' });

    expect(out.info).toHaveBeenCalledWith(
      'anomander store ready at /data/anomander.db (3 migrations applied)',
    );
    expect(out.warn).toHaveBeenCalledWith(
      "computer planning failed { reason: 'processor stopped' }",
    );
  });
});
