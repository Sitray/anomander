import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  handedAuthContext,
  readHandover,
  secretsOnStdin,
  stopsWithParent,
  stopWhenParentGoes,
} from '../../src/supervised.ts';

// DK-1 AC1 (docs/desktop-prd.md): the daemon stops when the app that started it is gone.
describe('a supervised daemon', () => {
  it('stops with its parent only when asked to', () => {
    expect(stopsWithParent({ ANOMANDER_STOP_WITH_PARENT: '1' })).toBe(true);
    expect(stopsWithParent({})).toBe(false);
    expect(stopsWithParent({ ANOMANDER_STOP_WITH_PARENT: 'true' })).toBe(false);
  });

  it('DK-1 AC1: stops once when stdin ends, and ignores what arrives on it', async () => {
    const stdin = new PassThrough();
    const stop = vi.fn();
    stopWhenParentGoes(stdin, stop);

    stdin.write('ignored');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).not.toHaveBeenCalled();

    stdin.end();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    stdin.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('DK-1 AC1: stops when stdin is closed without an end, as when the parent is killed', async () => {
    const stdin = new PassThrough();
    const stop = vi.fn();
    stopWhenParentGoes(stdin, stop);

    stdin.destroy();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });
});

// DK-5 AC2 (docs/desktop-prd.md): under the desktop app the secrets arrive as one JSON line on
// stdin, never in the environment; Docker and the CLI keep the environment.
describe('the secrets handed over on stdin', () => {
  const LINE = '{"TELEGRAM_BOT_TOKEN":"bot:secret","OPENAI_API_KEY":"sk-secret"}';

  it('are read only when the app says so', () => {
    expect(secretsOnStdin({ ANOMANDER_SECRETS_ON_STDIN: '1' })).toBe(true);
    expect(secretsOnStdin({})).toBe(false);
    expect(secretsOnStdin({ ANOMANDER_SECRETS_ON_STDIN: 'true' })).toBe(false);
  });

  it('are the JSON object of the first line, whatever follows it', async () => {
    const stdin = new PassThrough();
    const handed = readHandover(stdin);
    stdin.write(LINE.slice(0, 10));
    stdin.write(`${LINE.slice(10)}\nlater bytes\n{"not":"read"}\n`);
    await expect(handed).resolves.toEqual({
      TELEGRAM_BOT_TOKEN: 'bot:secret',
      OPENAI_API_KEY: 'sk-secret',
    });
  });

  it.each([
    ['not JSON', 'bot:secret-not-json'],
    ['a JSON array', '["bot:secret"]'],
    ['JSON null', 'null'],
    ['an object with a value that is not a string', '{"TELEGRAM_BOT_TOKEN":42,"K":"bot:secret"}'],
  ])('are refused when the line is %s, without quoting it', async (_, line) => {
    const stdin = new PassThrough();
    const handed = readHandover(stdin);
    stdin.write(`${line}\n`);
    const error = await handed.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('bot:secret');
    expect((error as Error).message).not.toContain('42');
  });

  it('are refused when stdin ends before a whole line', async () => {
    const stdin = new PassThrough();
    const handed = readHandover(stdin);
    stdin.end('{"TELEGRAM_BOT_TOKEN":"bot:secret"}');
    const error = await handed.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('bot:secret');
  });

  it('are refused when stdin is closed before a line', async () => {
    const stdin = new PassThrough();
    const handed = readHandover(stdin);
    stdin.destroy();
    await expect(handed).rejects.toThrow(Error);
  });

  it('are refused when no line arrives in time', async () => {
    const stdin = new PassThrough();
    const handed = readHandover(stdin, 20);
    stdin.write('{"TELEGRAM_BOT_TOKEN":"bot:se');
    const error = await handed.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('bot:se');
  });

  it('DK-1 AC1: leave stdin to stop the daemon once it ends after the handover', async () => {
    const stdin = new PassThrough();
    const handed = readHandover(stdin);
    stdin.write(`${LINE}\nignored`);
    await handed;
    const stop = vi.fn();
    stopWhenParentGoes(stdin, stop);

    stdin.write('ignored too');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).not.toHaveBeenCalled();

    stdin.end();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  describe('as pi-ai reads them', () => {
    it('a handed value wins over the environment, which is read as pi-ai reads it', async () => {
      const context = handedAuthContext(
        { OPENAI_API_KEY: 'sk-handed', BLANK_API_KEY: '  ' },
        { OPENAI_API_KEY: 'sk-env', GEMINI_API_KEY: 'g-env', EMPTY_API_KEY: ' ' },
      );
      await expect(context.env('OPENAI_API_KEY')).resolves.toBe('sk-handed');
      await expect(context.env('GEMINI_API_KEY')).resolves.toBe('g-env');
      await expect(context.env('BLANK_API_KEY')).resolves.toBeUndefined();
      await expect(context.env('EMPTY_API_KEY')).resolves.toBeUndefined();
      await expect(context.env('MISSING_API_KEY')).resolves.toBeUndefined();
      // Only the handed object's own names: nothing inherited from `Object.prototype`.
      await expect(context.env('toString')).resolves.toBeUndefined();
    });

    it('without a handover (Docker, the CLI) the environment alone answers', async () => {
      const context = handedAuthContext({}, { OPENAI_API_KEY: 'sk-env' });
      await expect(context.env('OPENAI_API_KEY')).resolves.toBe('sk-env');
      await expect(context.fileExists('/definitely/not/here')).resolves.toBe(false);
    });
  });
});
