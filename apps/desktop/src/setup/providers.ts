// DK-23 AC2: the providers the setup screen offers by name, the ones the daemon reaches through
// pi-ai, each with a model suggested for it. Its key is stored under the variable pi-ai reads
// (`keyName`), never shown: the screen names the key by `keyOwner`. A provider with a
// subscription login (R-27 AC1) names its account. Any other provider is still reached with
// "Otro modelo…" and its key by variable name. A daemon test checks that every suggested model
// is one pi-ai knows and that it reads photos, so one suggestion serves both models.

export interface SetupProvider {
  /** The pi-ai provider ID: what goes before the slash of `provider/model`. */
  id: string;
  /** How the screen names it. */
  name: string;
  /** Whose key it is, as in "Clave de Google AI Studio". */
  keyOwner: string;
  /** The variable the key is stored under, as the daemon reads it. */
  keyName: string;
  /** A model ID of this provider, without the provider. */
  suggested: string;
  /** The account of its subscription login (R-27 AC1), when it has one. */
  login?: string;
}

export const SETUP_PROVIDERS: readonly SetupProvider[] = [
  {
    id: 'google',
    name: 'Google Gemini',
    keyOwner: 'Google AI Studio',
    keyName: 'GEMINI_API_KEY',
    suggested: 'gemini-2.5-flash',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    keyOwner: 'OpenAI',
    keyName: 'OPENAI_API_KEY',
    suggested: 'gpt-5-mini',
    login: 'ChatGPT',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    keyOwner: 'Anthropic',
    keyName: 'ANTHROPIC_API_KEY',
    suggested: 'claude-haiku-4-5',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    keyOwner: 'OpenRouter',
    keyName: 'OPENROUTER_API_KEY',
    suggested: 'google/gemini-2.5-flash',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    keyOwner: 'Mistral',
    keyName: 'MISTRAL_API_KEY',
    suggested: 'mistral-small-latest',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    keyOwner: 'DeepSeek',
    keyName: 'DEEPSEEK_API_KEY',
    suggested: 'deepseek-flash',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    keyOwner: 'xAI',
    keyName: 'XAI_API_KEY',
    suggested: 'grok-4.3',
  },
  {
    id: 'kimi-coding',
    name: 'Kimi Code',
    keyOwner: 'Kimi Code',
    keyName: 'KIMI_API_KEY',
    suggested: 'k3',
    login: 'Kimi Code',
  },
];

/** The provider of `provider/model`, when the screen offers it by name. */
export const providerOfModel = (model: string): SetupProvider | undefined => {
  const slash = model.indexOf('/');
  return slash < 1 ? undefined : SETUP_PROVIDERS.find(({ id }) => id === model.slice(0, slash));
};

/** The provider whose key is stored under `keyName`, when the screen offers it by name. */
export const providerOfKey = (keyName: string): SetupProvider | undefined =>
  SETUP_PROVIDERS.find((provider) => provider.keyName === keyName);

/**
 * Whether `model` is known to read photos: only the suggested models, which a daemon test checks
 * against pi-ai's metadata. The window does not load pi-ai, so any other model is not assumed to.
 */
export const readsPhotos = (model: string): boolean =>
  SETUP_PROVIDERS.some((provider) => suggestedModel(provider) === model);

/** `google/gemini-2.5-flash`. */
export const suggestedModel = (provider: SetupProvider): string =>
  `${provider.id}/${provider.suggested}`;
