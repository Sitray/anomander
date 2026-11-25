import type { ProbeOutcome } from '@anomander/protocol';
import type { AiBudget } from '../budget/ai-budget.ts';
import type { Complete, Logger } from '../processor/ports.ts';
import { isProviderLimit } from '../processor/provider-limit.ts';
import { ProcessorTimeoutError, withTimeout } from '../processor/timeout.ts';
import type { SetupGap } from './setup-guide.ts';

// DK-23 AC4: "Probar" in the setup screen. One minimal call to the saved model, so the principal
// knows the model and its key work before writing to ANOMANDER. It is a processor call like any
// other: it counts against the daily AI budget (R-12) and has the processor's timeout (R-22 AC2),
// but it is never retried, so it is exactly one call. The provider's error can quote the key, so
// neither the window nor the log ever gets its words: only the outcome, in a code word.

/** What a probe answers while the setup names no usable model: no call can be made. */
export const probeWithoutModel = (gaps: readonly SetupGap[]): ProbeOutcome =>
  gaps.some((gap) => gap.kind === 'model_unknown') ? 'model_unknown' : 'model_unset';

/** The outcome a provider's error text says, never the text itself. */
export const probeOutcomeOf = (errorMessage: string | undefined): ProbeOutcome => {
  const reason = errorMessage ?? '';
  if (isProviderLimit(reason)) return 'provider_limit';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|api.?key|permission.?denied/i.test(reason)) {
    return 'key_refused';
  }
  if (/\b404\b|not.?found|does not exist|unknown model/i.test(reason)) return 'model_unavailable';
  return 'failed';
};

export interface ModelProbeDeps<M> {
  /** The raw processor call (pi-ai's `models.complete`), not the budgeted or retried one. */
  complete: Complete<M>;
  model: M;
  budget: AiBudget;
  /** The connection gaps (R-28 AC4): a provider without a key or a login is not called. */
  gaps: () => Promise<readonly SetupGap[]>;
  timeoutMs: number;
  logger: Logger;
}

const PROMPT = 'Answer with the single word: ok';

/** Runs one probe; it never throws. */
export const createModelProbe = <M>({
  complete,
  model,
  budget,
  gaps,
  timeoutMs,
  logger,
}: ModelProbeDeps<M>): (() => Promise<ProbeOutcome>) => {
  const timed = withTimeout(complete, timeoutMs);
  const outcome = async (): Promise<ProbeOutcome> => {
    if ((await gaps()).length > 0) return 'not_connected';
    if (!budget.tryConsume()) return 'budget_exhausted';
    try {
      const response = await timed(model, {
        systemPrompt: PROMPT,
        messages: [{ role: 'user', content: 'ok', timestamp: Date.now() }],
      });
      return response.stopReason === 'error' || response.stopReason === 'aborted'
        ? probeOutcomeOf(response.errorMessage)
        : 'ok';
    } catch (error) {
      return error instanceof ProcessorTimeoutError ? 'timed_out' : 'failed';
    }
  };
  return async () => {
    const result = await outcome().catch(() => 'failed' as const);
    // Only the code word: the provider's own words may quote the key.
    if (result !== 'ok') logger.warn('the model probe did not pass', { outcome: result });
    return result;
  };
};
