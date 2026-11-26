import type { ModelLogin } from '../auth/telegram-login.ts';

// B81 (desktop PRD DK-4 AC7, PRD R-27 AC3): the app's windows are told while a login started in
// Telegram waits for a text the principal pastes, so a text sent then whose answer never comes
// is masked there too. The login itself is unchanged: only its prompts are watched.

/**
 * `models` as a login uses them, calling `waits(true)` when the login starts waiting for a text
 * the principal pastes (a `manual_code` or `text` prompt) and `waits(false)` once it no longer
 * does: when that prompt ends, however it ended, or when the login itself ends first, so a
 * prompt left pending never keeps the windows told it waits. Never sees what is pasted.
 */
export const watchingPastes = (
  models: ModelLogin,
  waits: (waiting: boolean) => void,
): ModelLogin => {
  /** The paste prompts pending now, of every login, each counted once. */
  const pending = new Set<object>();
  const settle = (prompts: Iterable<object>) => {
    const before = pending.size;
    for (const prompt of prompts) pending.delete(prompt);
    if (before > 0 && pending.size === 0) waits(false);
  };
  return {
    login: async (providerId, type, interaction, options) => {
      /** This login's paste prompts still pending. */
      const own = new Set<object>();
      try {
        return await models.login(
          providerId,
          type,
          {
            ...interaction,
            prompt: async (prompt) => {
              if (prompt.type !== 'manual_code' && prompt.type !== 'text') {
                return interaction.prompt(prompt);
              }
              const asked = {};
              own.add(asked);
              pending.add(asked);
              if (pending.size === 1) waits(true);
              try {
                return await interaction.prompt(prompt);
              } finally {
                own.delete(asked);
                settle([asked]);
              }
            },
          },
          options,
        );
      } finally {
        settle(own);
        own.clear();
      }
    },
    logout: (providerId) => models.logout(providerId),
  };
};
