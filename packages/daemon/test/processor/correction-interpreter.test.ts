import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import {
  correctionInterpreterPrompt,
  createPiAiCorrectionInterpreter,
} from '../../src/processor/correction-interpreter.ts';

// Contract test (PRD §15) on a recorded response whose JSON envelope is replaced.
const FIXTURES = resolve(import.meta.dirname, '../fixtures/correction-interpreter');
const recorded = (name: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));

const MODEL = { provider: 'openai', id: 'gpt-4o-mini' };

describe('pi-ai correction interpreter', () => {
  // R-14 AC2 and §16: a rejected item quotes the correction, so only its reason and predicate
  // are logged, as the text interpreter does (R-23 AC8).
  it('logs a rejected item without its text (R-14 AC2)', async () => {
    const answer: AssistantMessage = {
      ...recorded('total-28-40'),
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            kind: 'correction',
            inferences: [
              {
                subject_type: 'expense',
                subject_id: null,
                predicate: 'merchant',
                value_json: 'Casa Secreta',
                mode: 'declared',
                basis_json: { quote: 'en casa secreta' },
                confidence: 0.9,
              },
            ],
          }),
        },
      ],
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const interpret = createPiAiCorrectionInterpreter({
      complete: async () => answer,
      model: MODEL,
      logger,
    });

    const interpretation = await interpret({
      text: 'era en casa secreta',
      expense: {
        total_cents: 2340,
        merchant: 'Mercadona',
        category: null,
        occurred_on: '2026-10-29',
      },
      categories: [],
      today: '2026-10-30',
    });

    expect(interpretation).toEqual({ kind: 'correction', inferences: [] });
    expect(logger.warn).toHaveBeenCalledWith('processor output rejected', {
      reason: 'claimed_mode:declared',
      predicate: 'merchant',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/secreta|"item"/i);
  });

  it('B59: tells the weekday of "today" beside it, to resolve "el lunes"', async () => {
    const contexts: Context[] = [];
    const interpret = createPiAiCorrectionInterpreter({
      complete: async (_model, context) => {
        contexts.push(context);
        return {
          ...recorded('nothing'),
          content: [{ type: 'text', text: '{"kind":"correction","inferences":[]}' }],
        };
      },
      model: MODEL,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await interpret({
      text: 'fue el lunes',
      expense: { total_cents: 2340, merchant: null, category: null, occurred_on: '2026-11-25' },
      categories: [],
      today: '2026-11-25',
    });

    expect(JSON.parse(String(contexts[0]?.messages[0]?.content))).toMatchObject({
      today: '2026-11-25',
      weekday: 'Wednesday',
    });
    expect(correctionInterpreterPrompt()).toContain(
      '"occurred_on": the new purchase date as YYYY-MM-DD, resolved against "today" and "weekday".',
    );
    expect(correctionInterpreterPrompt()).toContain(
      'The user turn is a JSON object with the fields "expense" (the values being corrected), "categories", "today", "weekday" (the day of the week of "today") and "message".',
    );
  });
});
