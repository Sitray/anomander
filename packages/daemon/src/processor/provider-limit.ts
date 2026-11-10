// The AI provider refused a call because its own quota or rate limit is spent (a 429). That is
// not a failure to understand: the principal is told so, to wait or to check their plan.

/** Whether `reason`, a provider's error text, says its quota or rate limit is spent. */
export const isProviderLimit = (reason: string | undefined): boolean =>
  reason !== undefined && /\b429\b|quota|rate.?limit|resource.?exhausted/i.test(reason);
