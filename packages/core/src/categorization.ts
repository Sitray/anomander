import type { CategoryBasis } from './ontology.ts';

export interface CategoryPolicy {
  merchant: string;
  category: string;
}

export interface CategorizationInput {
  merchant: string;
  /** Active policies only (R-13); inactive ones must be filtered out by the caller. */
  policies: readonly CategoryPolicy[];
  /** Names of the categories the principal created. */
  categories: readonly string[];
  /** A category the principal stated (R-3 AC5, R-2 AC3). */
  declaredCategory: string | null;
  /** A category the processor inferred. */
  suggestedCategory: string | null;
}

export interface Categorization {
  category: string | null;
  basis: CategoryBasis | null;
  /** A declared category that does not exist yet (handled by R-18 AC3). */
  missingDeclaredCategory: string | null;
}

const normalize = (name: string): string => name.trim().toLowerCase();

/**
 * R-5: declared, then policy, then an existing inferred category, else none. Nothing here can
 * yield a category outside `categories` except a policy, which only the principal declares.
 */
export const categorize = (input: CategorizationInput): Categorization => {
  const existing = new Set(input.categories.map(normalize));
  const none = { category: null, basis: null, missingDeclaredCategory: null };

  if (input.declaredCategory !== null) {
    const declared = normalize(input.declaredCategory);
    return existing.has(declared)
      ? { category: declared, basis: 'declared', missingDeclaredCategory: null }
      : { ...none, missingDeclaredCategory: declared };
  }

  const merchant = normalize(input.merchant);
  const policy = input.policies.find((candidate) => normalize(candidate.merchant) === merchant);
  if (policy) {
    return { category: normalize(policy.category), basis: 'policy', missingDeclaredCategory: null };
  }

  if (input.suggestedCategory !== null) {
    const suggested = normalize(input.suggestedCategory);
    if (existing.has(suggested)) {
      return { category: suggested, basis: 'inferred', missingDeclaredCategory: null };
    }
  }

  return none;
};
