import type { ModelLogin } from '../auth/telegram-login.ts';

// B81 (desktop PRD DK-4 AC7, PRD R-27 AC3): the app's windows are told while a login started in
// Telegram waits for a text the principal pastes, so a text sent then whose answer never comes
// is masked there too. The login itself is unchanged: only its prompts are watched.

/**
 * `models` as a login uses them, calling `waits(true)` when the login starts waiting for a text
 * the principal pastes (a `manual_code` or `text` prompt) and `waits(false)` once it no longer
 * does, however the prompt ended. Never sees what is pasted.
 */
export const watchingPastes = (
  models: ModelLogin,
  waits: (waiting: boolean) => void,
): ModelLogin => {
  let prompts = 0;
  return {
    login: (providerId, type, interaction, options) =>
      models.login(
        providerId,
        type,
        {
          ...interaction,
          prompt: async (prompt) => {
            if (prompt.type !== 'manual_code' && prompt.type !== 'text') {
              return interaction.prompt(prompt);
            }
            prompts += 1;
            if (prompts === 1) waits(true);
            try {
              return await interaction.prompt(prompt);
            } finally {
              prompts -= 1;
              if (prompts === 0) waits(false);
            }
          },
        },
        options,
      ),
    logout: (providerId) => models.logout(providerId),
  };
};
