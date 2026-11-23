import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError } from '../../src/budget/ai-budget.ts';
import { createPiAiScreenReader, screenReaderPrompt } from '../../src/processor/screen-reader.ts';

// A look at the screen, on its own with a fake `complete`. The question through the local
// channel is in `test/desktop/local-channel.test.ts`; this pins the function's own contract.
const MODEL = { provider: 'openai', id: 'gpt-4o-mini' };
const QUESTION = '¿De quién es este correo?';
const IMAGE = { mimeType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) };

const answer = (
  text: string,
  stopReason: AssistantMessage['stopReason'] = 'stop',
  errorMessage?: string,
) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 0,
  }) as AssistantMessage;

const readerAnswering = (respond: () => Promise<AssistantMessage>) => {
  const contexts: Context[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const read = createPiAiScreenReader({
    complete: async (_model: typeof MODEL, context: Context) => {
      contexts.push(context);
      return respond();
    },
    model: MODEL,
    logger,
  });
  return { read, contexts, logger };
};

const reading = (respond: () => Promise<AssistantMessage>) =>
  readerAnswering(respond).read({ question: QUESTION, image: IMAGE });

describe('the screen reader', () => {
  it('asks with one system prompt and one user turn: the question, the memories and the capture', async () => {
    const { read, contexts } = readerAnswering(async () => answer('Es de Ana.'));
    const memories = [{ text: 'Trabajo con Ana', mode: 'declared' as const }];

    await read({ question: QUESTION, image: IMAGE, memories });

    expect(contexts).toHaveLength(1);
    const [context] = contexts;
    expect(context?.systemPrompt).toBe(screenReaderPrompt());
    expect(context).not.toHaveProperty('tools');
    expect(context?.messages).toHaveLength(1);
    expect(context?.messages[0]?.content).toEqual([
      { type: 'text', text: JSON.stringify({ question: QUESTION, memories }) },
      { type: 'image', mimeType: 'image/png', data: Buffer.from(IMAGE.data).toString('base64') },
    ]);
  });

  it('answers in the processor words, trimmed and cut to what one message holds', async () => {
    expect(await reading(async () => answer('  Es de Ana.  '))).toEqual({
      kind: 'answer',
      text: 'Es de Ana.',
    });
    const long = await reading(async () => answer('a'.repeat(5000)));
    expect(long).toEqual({ kind: 'answer', text: 'a'.repeat(4096) });
  });

  it('fails, and logs the reason without the question, when the processor answers nothing', async () => {
    const { read, logger } = readerAnswering(async () => answer('   '));

    expect(await read({ question: QUESTION, image: IMAGE })).toEqual({ kind: 'failed' });
    expect(logger.warn).toHaveBeenCalledWith('screen reading failed', {
      reason: 'the processor answered nothing',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(QUESTION);
  });

  it('tells a spent budget, a spent provider quota and a failed call apart', async () => {
    expect(
      await reading(async () => {
        throw new AiBudgetExhaustedError();
      }),
    ).toEqual({ kind: 'budget_exhausted' });
    expect(
      await reading(async () => {
        throw new Error('{"error":{"code":429,"message":"You exceeded your current quota"}}');
      }),
    ).toEqual({ kind: 'provider_limit' });
    expect(await reading(async () => answer('', 'error', 'rate limit reached'))).toEqual({
      kind: 'provider_limit',
    });
    expect(
      await reading(async () => {
        throw new Error('the provider is down');
      }),
    ).toEqual({ kind: 'failed' });
    expect(await reading(async () => answer('', 'aborted'))).toEqual({ kind: 'failed' });
  });
});
