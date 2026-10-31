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
});

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
      message: text,
    });
  });

  it('classifies open conversation and returns its reply (R-16)', async () => {
    const { interpret } = interpreterFor('conversation');

    expect(await interpret(input('hola'))).toEqual({
      kind: 'conversation',
      reply: '¡Hola! Cuando quieras, dime un gasto, por ejemplo: 23,40 en Mercadona.',
    });
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
