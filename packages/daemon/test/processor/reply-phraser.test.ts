import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { checkedPhrasing, createPiAiReplyPhraser } from '../../src/processor/reply-phraser.ts';

// R-21: the processor may word S-1, S-2, S-16 and S-21; code keeps the facts.
const MODEL = { provider: 'openai', id: 'gpt-4o-mini' };
const REFERENCE = 'Apuntado: 23,00 € en Mercadona (restaurantes).';
const FACTS = ['23,00 €', 'Mercadona', 'restaurantes'];

const answer = (text: string, stopReason: AssistantMessage['stopReason'] = 'stop') =>
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
    timestamp: 0,
  }) as AssistantMessage;

const phraserAnswering = (respond: () => Promise<AssistantMessage>) => {
  const contexts: Context[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const phrase = createPiAiReplyPhraser({
    complete: async (_model: typeof MODEL, context: Context) => {
      contexts.push(context);
      return respond();
    },
    model: MODEL,
    logger,
  });
  return { phrase, contexts };
};

const phrased = (respond: () => Promise<AssistantMessage>) =>
  phraserAnswering(respond).phrase({ reference: REFERENCE, facts: FACTS, message: '23 € cena' });

describe('R-21 phrased replies', () => {
  it('AC1: sends the phrased text when it keeps every fact', async () => {
    // The model may write a plain space where Intl writes a no-break space.
    const text = '¡Listo! He apuntado 23,00 € en Mercadona, en restaurantes. ¡Que aproveche!';

    expect(await phrased(async () => answer(text))).toBe(text);
  });

  it.each([
    ['drops a fact', 'He apuntado 23,00 € en restaurantes.'],
    [
      'adds an amount',
      'He apuntado 23,00 € en Mercadona (restaurantes); llevas 80,00 € esta semana.',
    ],
    [
      'is longer than 280 characters',
      `He apuntado 23,00 € en Mercadona (restaurantes). ${'Ok. '.repeat(70)}`,
    ],
    ['is empty', '   '],
  ])('AC2: falls back to the §12 string when the phrasing %s', async (_label, text) => {
    expect(await phrased(async () => answer(text))).toBe(REFERENCE);
  });

  it.each([
    ['a grouped amount', 'Apuntado: 23,00 € (sin clasificar); llevas 1.234,56 € este mes.'],
    ['a thousands amount', 'Apuntado: 23,00 € (sin clasificar); presupuesto 23.000 €.'],
    ['three decimals', 'Apuntado: 23,00 € (sin clasificar); 12,345 €.'],
  ])('AC2: falls back to the §12 string when the phrasing adds %s', async (_label, text) => {
    const { phrase } = phraserAnswering(async () => answer(text));
    const reference = 'Apuntado: 23,00 € (sin clasificar).';

    expect(await phrase({ reference, facts: ['23,00 €', 'sin clasificar'], message: '23' })).toBe(
      reference,
    );
  });

  it('AC2: tells a stored grouped total from an invented one', async () => {
    const reference = 'Apuntado: 12.345,67 € (sin clasificar).';
    const request = { reference, facts: ['12.345,67 €', 'sin clasificar'], message: '12345,67' };
    const kept = 'Hecho: 12.345,67 € (sin clasificar).';
    const invented = 'Hecho: 12.345,67 € (sin clasificar), 99.999,99 € en total.';

    expect(await phraserAnswering(async () => answer(kept)).phrase(request)).toBe(kept);
    expect(await phraserAnswering(async () => answer(invented)).phrase(request)).toBe(reference);
  });

  it('AC2: a number in a date fact is not an amount (S-21)', async () => {
    const reference = 'La fecha 5 de noviembre es posterior a hoy. ¿Me dices cuándo fue el gasto?';
    const { phrase } = phraserAnswering(async () => answer('He apuntado 5 € el 5 de noviembre.'));

    expect(await phrase({ reference, facts: ['5 de noviembre'], message: '5 € mañana' })).toBe(
      reference,
    );
  });

  it('AC2: falls back to the §12 string when the processor fails', async () => {
    expect(await phrased(async () => Promise.reject(new Error('timeout')))).toBe(REFERENCE);
    expect(await phrased(async () => answer('', 'error'))).toBe(REFERENCE);
  });

  it('AC2: logs a rejected phrasing without its text, which may echo a memory (R-23 AC8)', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const rejected = 'Como eres vegetariano estricto, ya la tienes.';

    expect(checkedPhrasing(rejected, { reference: REFERENCE, facts: FACTS }, logger)).toBe(
      REFERENCE,
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('vegetariano');
  });

  it('AC4: never passes tools to the processor', async () => {
    const { phrase, contexts } = phraserAnswering(async () => answer(REFERENCE));
    await phrase({ reference: REFERENCE, facts: FACTS, message: '23 € cena' });

    // Only a system prompt and user turns: no `tools` key and no tool-carrying messages.
    expect(contexts).toHaveLength(1);
    expect(Object.keys(contexts[0] ?? {}).sort()).toEqual(['messages', 'systemPrompt']);
    expect(contexts[0]?.messages.map(({ role }) => role)).toEqual(['user']);
  });
});
