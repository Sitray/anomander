import { describe, expect, it } from 'vitest';
import { type CategorizationInput, categorize } from '../src/index.ts';

const input = (overrides: Partial<CategorizationInput> = {}): CategorizationInput => ({
  merchant: 'Mercadona',
  policies: [{ merchant: 'Mercadona', category: 'supermercado' }],
  categories: ['supermercado', 'restaurantes'],
  declaredCategory: null,
  suggestedCategory: null,
  ...overrides,
});

const none = { category: null, basis: null, missingDeclaredCategory: null };

describe('R-5 categorization', () => {
  it('AC1: an active policy for the merchant yields its category with basis policy', () => {
    expect(
      categorize(input({ merchant: '  MERCADONA ', suggestedCategory: 'restaurantes' })),
    ).toEqual({ category: 'supermercado', basis: 'policy', missingDeclaredCategory: null });
  });

  it('AC2: without a policy, an existing suggested category is inferred', () => {
    expect(categorize(input({ policies: [], suggestedCategory: ' Restaurantes' }))).toEqual({
      category: 'restaurantes',
      basis: 'inferred',
      missingDeclaredCategory: null,
    });
  });

  it('AC3: the processor can never create a category', () => {
    expect(categorize(input({ policies: [], suggestedCategory: 'gasolina' }))).toEqual(none);
  });

  it('a category declared by the principal wins over policy and suggestion', () => {
    expect(
      categorize(input({ declaredCategory: 'Restaurantes', suggestedCategory: 'supermercado' })),
    ).toEqual({ category: 'restaurantes', basis: 'declared', missingDeclaredCategory: null });
  });

  it('a declared category that does not exist yields none and is reported (R-18 AC3)', () => {
    expect(categorize(input({ declaredCategory: 'Gasolina' }))).toEqual({
      ...none,
      missingDeclaredCategory: 'gasolina',
    });
  });
});
