import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isLiteralAmount } from '@anomander/core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { createPiAiTextInterpreter } from '../../src/processor/text-interpreter.ts';

// Contract tests (PRD §15) on recorded responses: fixtures/text-interpreter/*.json.
const FIXTURES = resolve(import.meta.dirname, '../fixtures/text-interpreter');
const recorded = (name: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));

const MODEL = { provider: 'openai', id: 'gpt-4o-mini' };

const interpreterFor = (fixture: string) => {
  const contexts: Context[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const complete = async (model: typeof MODEL, context: Context) => {
    expect(model).toBe(MODEL);
    contexts.push(context);
    return recorded(fixture);
  };
  const interpret = createPiAiTextInterpreter({ complete, model: MODEL, logger });
  return { interpret, contexts, logger };
};

const input = (text: string) => ({
  text,
  today: '2026-10-30',
  categories: ['restaurantes', 'supermercado'],
  recent: [],
  memories: [],
});

// A recorded response whose JSON envelope is replaced, for cases no recording covers.
const answering = (envelope: unknown): AssistantMessage => ({
  ...recorded('conversation'),
  content: [{ type: 'text', text: JSON.stringify(envelope) }],
});

const interpreterAnswering = (envelope: unknown) => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const interpret = createPiAiTextInterpreter({
    complete: async () => answering(envelope),
    model: MODEL,
    logger,
  });
  return { interpret, logger };
};

describe('pi-ai text interpreter', () => {
  // R-2 AC5: the six amount forms are the contract cases and the inputs of the AC6 check.
  it.each([
    ['23 cena', 2300, 'expense-23'],
    ['23,40 Mercadona', 2340, 'expense-23-comma-40'],
    ['23.40 Mercadona', 2340, 'expense-23-dot-40'],
    ['23€ cena', 2300, 'expense-23-euro'],
    ['23 € cena', 2300, 'expense-23-space-euro'],
    ['€23 cena', 2300, 'expense-euro-23'],
  ])('interprets %j as an expense of %i cents', async (text, cents, fixture) => {
    const { interpret, contexts } = interpreterFor(fixture);

    const interpretation = await interpret(input(text));

    expect(interpretation.kind).toBe('expense');
    const inferences = interpretation.kind === 'expense' ? interpretation.inferences : [];
    const total = inferences.find((inference) => inference.predicate === 'total');
    expect(total).toMatchObject({ subject_type: 'expense', mode: 'inferred', value_json: cents });
    expect(isLiteralAmount(text, total?.value_json as number)).toBe(true);
    const userTurn = contexts[0]?.messages[0]?.content;
    expect(JSON.parse(String(userTurn))).toEqual({
      today: '2026-10-30',
      categories: ['restaurantes', 'supermercado'],
      recent: [],
      memories: [],
      message: text,
    });
  });

  it('classifies open conversation and returns its reply (R-16)', async () => {
    const { interpret } = interpreterFor('conversation');

    expect(await interpret(input('hola'))).toEqual({
      kind: 'conversation',
      reply: '¡Hola! Cuando quieras, dime un gasto, por ejemplo: 23,40 en Mercadona.',
      memories: [],
    });
  });

  it('returns the lasting facts it found and drops invalid ones without logging them (R-23 AC1, AC8)', async () => {
    const { interpret, logger } = interpreterAnswering({
      kind: 'conversation',
      reply: 'Tomo nota.',
      memories: [
        { text: 'Es vegetariano', quote: 'soy vegetariano', said: true, confidence: 0.95 },
        {
          text: 'Vive en Madrid',
          quote: 'vivo en Madrid',
          said: true,
          confidence: 0.9,
          replaces: 7,
        },
        { text: 'Le gusta el cine', quote: 'cine', said: 'yes', confidence: 0.6 },
      ],
    });

    const interpretation = await interpret(
      input('soy vegetariano y vivo en Madrid, me gusta el cine'),
    );

    expect(interpretation).toEqual({
      kind: 'conversation',
      reply: 'Tomo nota.',
      memories: [
        {
          text: 'Es vegetariano',
          quote: 'soy vegetariano',
          said: true,
          confidence: 0.95,
          replaces: null,
        },
        {
          text: 'Vive en Madrid',
          quote: 'vivo en Madrid',
          said: true,
          confidence: 0.9,
          replaces: 7,
        },
      ],
    });
    expect(logger.warn).toHaveBeenCalledWith('processor memory rejected', {
      reason: 'invalid:said invalid_type',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/cine/);
  });

  it('rejects an expense inference whose quote is not in the message (R-23 AC4)', async () => {
    const { interpret, logger } = interpreterAnswering({
      kind: 'expense',
      inferences: [
        {
          subject_type: 'expense',
          subject_id: null,
          predicate: 'total',
          value_json: 2300,
          mode: 'inferred',
          basis_json: { quote: '23  €' },
          confidence: 0.98,
        },
        {
          subject_type: 'expense',
          subject_id: null,
          predicate: 'merchant',
          value_json: 'Casa Pepe',
          mode: 'inferred',
          basis_json: { quote: 'siempre ceno en Casa Pepe' },
          confidence: 0.7,
        },
        {
          subject_type: 'expense',
          subject_id: null,
          predicate: 'category',
          value_json: 'restaurantes',
          mode: 'inferred',
          basis_json: { reason: 'dinner' },
          confidence: 0.8,
        },
      ],
    });

    const interpretation = await interpret(input('23 € CENA'));

    expect(interpretation.kind === 'expense' && interpretation.inferences).toEqual([
      expect.objectContaining({ predicate: 'total', value_json: 2300 }),
    ]);
    expect(logger.warn.mock.calls).toEqual([
      ['processor output rejected', { reason: 'quote_not_in_message', predicate: 'merchant' }],
      ['processor output rejected', { reason: 'quote_not_in_message', predicate: 'category' }],
    ]);
  });

  it('rejects and logs a processor item that claims to be a declaration (R-14 AC2)', async () => {
    const { interpret, logger } = interpreterFor('claims-declared');

    const interpretation = await interpret(input('23 € cena'));

    expect(interpretation.kind === 'expense' && interpretation.inferences).toEqual([
      expect.objectContaining({ predicate: 'total', value_json: 2300 }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'processor output rejected',
      expect.objectContaining({ reason: 'claimed_mode:declared' }),
    );
    // R-23 AC8: a rejected item may echo a memory, so only its predicate is logged.
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('"item"');
  });

  it('returns invalid for a response that is not the JSON envelope (A3)', async () => {
    const { interpret, logger } = interpreterFor('malformed');

    expect((await interpret(input('23 euros cena'))).kind).toBe('invalid');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never passes tools to the processor (R-14 AC3)', async () => {
    const fixtures = ['expense-23', 'conversation', 'claims-declared', 'malformed'];
    for (const fixture of fixtures) {
      const { interpret, contexts } = interpreterFor(fixture);
      await interpret(input('23 € cena'));
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).not.toHaveProperty('tools');
      expect(contexts[0]?.systemPrompt).toEqual(expect.any(String));
      expect(contexts[0]?.messages).toEqual([expect.objectContaining({ role: 'user' })]);
    }
  });
});
