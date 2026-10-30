import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pngBytes } from '@anomander/telegram/fake-telegram-api';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { createPiAiReceiptReader } from '../../src/processor/receipt-reader.ts';

// Contract test (PRD §15) on a hand-authored recorded response: fixtures/receipt-reader/*.json.
const FIXTURES = resolve(import.meta.dirname, '../fixtures/receipt-reader');
const recorded = (name: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));

const VISION_MODEL = { provider: 'openai', id: 'gpt-4o' };

describe('pi-ai receipt reader', () => {
  it('sends the images as image blocks with no tools and returns inferences (R-3 AC2, R-14 AC3)', async () => {
    const contexts: Context[] = [];
    const complete = async (model: typeof VISION_MODEL, context: Context) => {
      expect(model).toBe(VISION_MODEL);
      contexts.push(context);
      return recorded('adds-up');
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const read = createPiAiReceiptReader({ complete, model: VISION_MODEL, logger });
    const images = [
      { mimeType: 'image/png', data: pngBytes(1) },
      { mimeType: 'image/png', data: pngBytes(2) },
    ];

    const reading = await read({
      images,
      caption: 'compra',
      today: '2026-10-30',
      categories: ['restaurantes', 'supermercado'],
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).not.toHaveProperty('tools');
    const [turn] = contexts[0]?.messages ?? [];
    expect(turn?.role).toBe('user');
    const [text, ...blocks] =
      turn?.role === 'user' && Array.isArray(turn.content) ? turn.content : [];
    expect(text?.type === 'text' && JSON.parse(text.text)).toEqual({
      today: '2026-10-30',
      categories: ['restaurantes', 'supermercado'],
      caption: 'compra',
    });
    expect(blocks).toEqual(
      images.map(({ mimeType, data }) => ({
        type: 'image',
        mimeType,
        data: Buffer.from(data).toString('base64'),
      })),
    );

    expect(reading.kind).toBe('read');
    if (reading.kind !== 'read') return;
    expect(reading.total.value).toBe(2340);
    expect(reading.merchant.value).toBe('Mercadona');
    expect(reading.occurredOn.value).toBe('2026-10-29');
    expect(reading.lines.map((line) => line.value)).toEqual([
      { name: 'LECHE ENTERA 1L', quantity: 2, amount_cents: 178 },
      { name: 'ACEITE OLIVA 1L', quantity: 1, amount_cents: 895 },
      { name: 'FRUTA', quantity: 1, amount_cents: 1267 },
    ]);
    expect(reading.total.inference).toMatchObject({
      mode: 'inferred',
      basis_json: expect.anything(),
    });
  });
});
