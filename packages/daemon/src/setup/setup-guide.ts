import { strings } from '@anomander/protocol';
import { LOGIN_ACCOUNTS } from '../auth/telegram-login.ts';
import type { Config, ModelId } from '../config.ts';

// R-28: what the daemon still needs from `.env` to reach a model. Model gaps are found once at
// start, since only a restart rereads `.env`; connection gaps on every message, so a login
// (R-27) completes setup without one.

type ModelVariable = 'ANOMANDER_MODEL' | 'ANOMANDER_VISION_MODEL';

export type SetupGap =
  | { kind: 'model_unset' }
  | { kind: 'model_unknown'; variable: ModelVariable; model: string }
  | { kind: 'provider_unconnected'; providerId: string };

export type ResolvedModels<M> =
  | { ready: true; model: M; visionModel: M; providerIds: readonly string[] }
  | { ready: false; gaps: readonly SetupGap[] };

const named = ({ provider, id }: ModelId) => `${provider}/${id}`;

/** Resolves both models of `config` with `getModel` (pi-ai's `models.getModel`), or its gaps. */
export const resolveModels = <M>(
  config: Pick<Config, 'model' | 'visionModel'>,
  getModel: (provider: string, id: string) => M | undefined,
): ResolvedModels<M> => {
  const { model, visionModel } = config;
  if (model === undefined || visionModel === undefined) {
    return { ready: false, gaps: [{ kind: 'model_unset' }] };
  }
  const text = getModel(model.provider, model.id);
  const vision = getModel(visionModel.provider, visionModel.id);
  if (text === undefined || vision === undefined) {
    const unknown = (variable: ModelVariable, id: ModelId): SetupGap[] => [
      { kind: 'model_unknown', variable, model: named(id) },
    ];
    return {
      ready: false,
      gaps: [
        ...(text === undefined ? unknown('ANOMANDER_MODEL', model) : []),
        ...(vision === undefined ? unknown('ANOMANDER_VISION_MODEL', visionModel) : []),
      ],
    };
  }
  return {
    ready: true,
    model: text,
    visionModel: vision,
    providerIds: [...new Set([model.provider, visionModel.provider])],
  };
};

export interface ConnectionGapsDeps {
  providerIds: readonly string[];
  /** pi-ai's `models.checkAuth`: `undefined` when the provider has no login and no API key. */
  checkAuth: (providerId: string) => Promise<unknown>;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
}

/**
 * The providers with neither a login nor an API key. A provider whose check fails, such as an
 * unreadable credential file, is not a gap: the processor call reports that failure instead.
 */
export const createConnectionGaps =
  ({ providerIds, checkAuth, logger }: ConnectionGapsDeps) =>
  async (): Promise<readonly SetupGap[]> => {
    const gaps: SetupGap[] = [];
    for (const providerId of providerIds) {
      try {
        if ((await checkAuth(providerId)) === undefined) {
          gaps.push({ kind: 'provider_unconnected', providerId });
        }
      } catch (error) {
        logger.warn('Could not check a provider connection', { providerId, error });
      }
    }
    return gaps;
  };

const accountOf = (providerId: string) =>
  LOGIN_ACCOUNTS.find((account) => account.providerId === providerId)?.label ?? providerId;

const lineOf = (gap: SetupGap): string => {
  switch (gap.kind) {
    case 'model_unset':
      return strings.setupModelUnset();
    case 'model_unknown':
      return strings.setupModelUnknown(gap.variable, gap.model);
    case 'provider_unconnected':
      return strings.setupProviderUnconnected(accountOf(gap.providerId));
  }
};

/** S-70 with one line per gap (R-28 AC3). */
export const setupGuide = (gaps: readonly SetupGap[]): string =>
  strings.setupGuide(gaps.map(lineOf));

/** The same gaps for the log, in English (R-28 AC3). */
export const describeGap = (gap: SetupGap): string => {
  switch (gap.kind) {
    case 'model_unset':
      return 'ANOMANDER_MODEL and ANOMANDER_VISION_MODEL must both be set';
    case 'model_unknown':
      return `${gap.variable} names a model pi-ai does not know: ${gap.model}`;
    case 'provider_unconnected':
      return `provider ${gap.providerId} has no login and no API key: use /login or set its key`;
  }
};
