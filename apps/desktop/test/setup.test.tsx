// @vitest-environment jsdom

import type { ProbeOutcome } from '@anomander/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETUP_PROVIDERS } from '../src/setup/providers.ts';
import { SetupScreen } from '../src/setup/SetupScreen.tsx';
import type { SetupInput, SetupState } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { EMPTY_SETUP, FILLED_SETUP } from './fixtures.ts';

// DK-5 AC1: the setup screen. Secrets go in and never come back out.
afterEach(cleanup);

const { setup: text } = strings;
const BOT_TOKEN = '123456:secret-bot-token';
const API_KEY = 'sk-secret-provider-key';
/** S5: past the first run, so a save needs no token or chat ID; nothing else stored. */
const CONFIGURED: SetupState = {
  ...EMPTY_SETUP,
  hasTelegramBotToken: true,
  principalChatId: '4242',
};

const renderSetup = (
  setup: SetupState,
  save: (input: SetupInput) => Promise<SetupState> = async () => FILLED_SETUP,
) => {
  const onSave = vi.fn(save);
  const onClose = vi.fn();
  render(<SetupScreen setup={setup} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose };
};

const field = (label: string): HTMLInputElement => screen.getByLabelText(label);
const fill = (label: string, value: string): void => {
  fireEvent.change(field(label), { target: { value } });
};
const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: text.save }));
};
const saved = async (onSave: ReturnType<typeof vi.fn>): Promise<SetupInput> => {
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  return onSave.mock.calls[0]?.[0] as SetupInput;
};

describe('what it shows', () => {
  it('shows an empty setup with where to get each value', () => {
    renderSetup(EMPTY_SETUP);

    expect(field(text.botToken).value).toBe('');
    expect(field(text.botToken).type).toBe('password');
    expect(field(text.chatId).value).toBe('');
    expect(screen.getByText(text.botTokenHelp)).toBeTruthy();
    expect(screen.getByText(text.chatIdHelp)).toBeTruthy();
    expect(screen.getByText(text.keysNone)).toBeTruthy();
  });

  it('shows the stored values, and of a secret only that it is stored', () => {
    renderSetup(FILLED_SETUP);

    expect(field(text.botToken).value).toBe('');
    expect(field(text.botToken).placeholder).toBe(text.botTokenStored);
    expect(field(text.chatId).value).toBe('4242');
    expect(field(text.model).value).toBe('openai/gpt-4o-mini');
    expect(field(text.visionModel).value).toBe('openai/gpt-4o-mini');
    const stored = screen.getByRole('list', { name: text.keys });
    expect(within(stored).getByText('OpenAI')).toBeTruthy();
    expect(within(stored).getByText(text.keyStored)).toBeTruthy();
  });
});

describe('saving', () => {
  it('sends the bot token only when one was typed', async () => {
    const { onSave } = renderSetup(FILLED_SETUP);
    fill(text.chatId, '777');
    save();

    const input = await saved(onSave);
    expect(input).toEqual({
      principalChatId: '777',
      model: 'openai/gpt-4o-mini',
      visionModel: 'openai/gpt-4o-mini',
      providerKeys: {},
    });
    expect('telegramBotToken' in input).toBe(false);
  });

  it('sends a typed bot token', async () => {
    const { onSave } = renderSetup(EMPTY_SETUP);
    fill(text.botToken, BOT_TOKEN);
    fill(text.chatId, '4242');
    save();

    expect(await saved(onSave)).toMatchObject({ telegramBotToken: BOT_TOKEN });
  });

  it('accepts a negative chat ID, as a group has', async () => {
    const { onSave } = renderSetup(FILLED_SETUP);
    fill(text.chatId, ' -1001234567890 ');
    save();

    expect(await saved(onSave)).toMatchObject({ principalChatId: '-1001234567890' });
  });

  it.each(['12a', '4 2', '--4', '4.2'])('refuses the chat ID %j before saving', (value) => {
    const { onSave } = renderSetup(FILLED_SETUP);
    fill(text.chatId, value);
    save();

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(text.chatIdInvalid)).toBeTruthy();
    expect(field(text.chatId).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(text.fixFields)).toBeTruthy();
  });

  it.each(['gpt-4o-mini', '/gpt-4o', 'openai/'])('refuses the model %j before saving', (value) => {
    const { onSave } = renderSetup(FILLED_SETUP);
    fill(text.visionModel, value);
    save();

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(text.modelInvalid)).toBeTruthy();
    expect(field(text.visionModel).getAttribute('aria-invalid')).toBe('true');
    expect(field(text.model).getAttribute('aria-invalid')).not.toBe('true');
  });

  it('saves empty models and an empty chat ID as unset, as the shell takes them', async () => {
    const { onSave } = renderSetup(FILLED_SETUP);
    fill(text.chatId, '');
    fill(text.model, '  ');
    fill(text.visionModel, '');
    save();

    expect(await saved(onSave)).toMatchObject({ principalChatId: '', model: '', visionModel: '' });
  });

  it('keeps a model with a slash in its name', async () => {
    const { onSave } = renderSetup(FILLED_SETUP);
    fill(text.model, 'openrouter/anthropic/claude');
    save();

    expect(await saved(onSave)).toMatchObject({ model: 'openrouter/anthropic/claude' });
  });

  it('shows the rejection of the shell and keeps what was typed', async () => {
    const { onSave, onClose } = renderSetup(EMPTY_SETUP, () =>
      Promise.reject('could not store TELEGRAM_BOT_TOKEN'),
    );
    fill(text.botToken, BOT_TOKEN);
    fill(text.chatId, '4242');
    save();
    await saved(onSave);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text.rejected);
    expect(alert.textContent).toContain('could not store TELEGRAM_BOT_TOKEN');
    expect(field(text.botToken).value).toBe(BOT_TOKEN);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('forgets every typed secret once saved', async () => {
    const { onSave } = renderSetup(EMPTY_SETUP, async () => EMPTY_SETUP);
    fill(text.botToken, BOT_TOKEN);
    fill(text.chatId, '4242');
    fill(text.keyValue, API_KEY);
    fireEvent.click(screen.getByRole('button', { name: text.addKey }));
    save();
    await saved(onSave);

    await waitFor(() => expect(field(text.botToken).value).toBe(''));
    expect(document.documentElement.outerHTML).not.toContain(BOT_TOKEN);
    expect(document.documentElement.outerHTML).not.toContain(API_KEY);
  });

  it('says what is still missing when the saved setup cannot start the daemon', async () => {
    renderSetup(EMPTY_SETUP, async () => EMPTY_SETUP);
    fill(text.botToken, BOT_TOKEN);
    fill(text.chatId, '4242');
    save();

    expect(await screen.findByText(text.savedIncomplete)).toBeTruthy();
  });

  // T13: Telegram is optional; what the chat needs is a model.
  it('on a first run asks for the model only, and shows Telegram as optional (S5)', () => {
    const { onSave } = renderSetup(EMPTY_SETUP);
    expect(screen.getByText(text.sectionTelegram)).toBeTruthy();
    expect(text.sectionTelegram).toBe('Telegram (opcional)');
    expect(screen.getAllByText(text.required)).toHaveLength(1);
    save();

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(text.modelMissing)).toBeTruthy();
    expect(field(text.model).getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(text.botTokenMissing)).toBeNull();
    expect(screen.queryByText(text.chatIdMissing)).toBeNull();
    expect(screen.getByText(text.fixFields)).toBeTruthy();
  });

  it('saves without Telegram when both of its fields are empty (T13)', async () => {
    const { onSave } = renderSetup(EMPTY_SETUP, async () => ({
      ...EMPTY_SETUP,
      model: 'openai/gpt-5-mini',
    }));
    fill(text.model, 'openai/gpt-5-mini');
    save();

    const input = await saved(onSave);
    expect(input).toEqual({
      principalChatId: '',
      model: 'openai/gpt-5-mini',
      // DK-23 AC2: left empty, photos are read with the same model.
      visionModel: 'openai/gpt-5-mini',
      providerKeys: {},
    });
    // Saved and able to start: nothing is said to be missing.
    await waitFor(() => expect(field(text.model).value).toBe('openai/gpt-5-mini'));
    expect(screen.queryByText(text.savedIncomplete)).toBeNull();
  });

  it('refuses half of Telegram before saving (T13)', () => {
    const { onSave } = renderSetup(EMPTY_SETUP);
    fill(text.model, 'openai/gpt-4o-mini');
    fill(text.botToken, BOT_TOKEN);
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(text.chatIdMissing)).toBeTruthy();
    expect(field(text.chatId).getAttribute('aria-invalid')).toBe('true');

    fill(text.botToken, '');
    fill(text.chatId, '4242');
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(text.botTokenMissing)).toBeTruthy();
    expect(screen.queryByText(text.chatIdMissing)).toBeNull();
  });

  it('takes a stored token as the half that is not typed', async () => {
    const { onSave } = renderSetup({ ...EMPTY_SETUP, hasTelegramBotToken: true });
    // Telegram whole can start the daemon without a model, as before.
    fill(text.chatId, '4242');
    save();
    expect(await saved(onSave)).toMatchObject({ principalChatId: '4242' });
  });

  it('shows the model as an example, not as a value (S5)', () => {
    renderSetup(EMPTY_SETUP);
    expect(field(text.model).placeholder).toBe(text.modelPlaceholder);
    expect(field(text.visionModel).placeholder).toBe(text.modelPlaceholder);
    expect(text.modelPlaceholder).not.toBe('openai/gpt-4o-mini');
    expect(field(text.model).value).toBe('');
  });

  it('takes no second save while one is in progress', async () => {
    let finish: (setup: SetupState) => void = () => {};
    const { onSave } = renderSetup(
      FILLED_SETUP,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    save();

    const saving = await screen.findByRole<HTMLButtonElement>('button', { name: text.saving });
    expect(saving.disabled).toBe(true);
    fireEvent.click(saving);
    expect(onSave).toHaveBeenCalledOnce();
    finish(FILLED_SETUP);
    await screen.findByRole('button', { name: text.save });
  });

  it('closes without saving', () => {
    const { onSave, onClose } = renderSetup(FILLED_SETUP);
    fireEvent.click(screen.getByRole('button', { name: text.cancel }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('provider keys', () => {
  const keyList = () => screen.getByRole('list', { name: text.keys });

  it('offers the providers of the setup by name, and any other by its variable', () => {
    renderSetup(EMPTY_SETUP);
    const options = within(field(text.provider)).getAllByRole<HTMLOptionElement>('option');

    expect(options.map((option) => option.textContent)).toEqual([
      ...SETUP_PROVIDERS.map((provider) => provider.keyOwner),
      text.otherProvider,
    ]);
    expect(options.map((option) => option.value)).toEqual([
      ...SETUP_PROVIDERS.map((provider) => provider.keyName),
      'other',
    ]);
  });

  it('stores an added key, never showing its value', async () => {
    const { onSave } = renderSetup(CONFIGURED);
    fireEvent.change(field(text.provider), { target: { value: 'ANTHROPIC_API_KEY' } });
    fill(text.keyValue, API_KEY);
    expect(field(text.keyValue).type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: text.addKey }));

    expect(within(keyList()).getByText('Anthropic')).toBeTruthy();
    expect(within(keyList()).getByText(text.keyNew)).toBeTruthy();
    expect(keyList().textContent).not.toContain(API_KEY);
    expect(field(text.keyValue).value).toBe('');

    save();
    expect((await saved(onSave)).providerKeys).toEqual({ ANTHROPIC_API_KEY: API_KEY });
  });

  it('stores a key typed but not added, so it is not lost', async () => {
    const { onSave } = renderSetup(CONFIGURED);
    fill(text.keyValue, API_KEY);
    save();

    expect((await saved(onSave)).providerKeys).toEqual({ GEMINI_API_KEY: API_KEY });
  });

  it('takes another provider by the name of its variable', async () => {
    const { onSave } = renderSetup(CONFIGURED);
    fireEvent.change(field(text.provider), { target: { value: 'other' } });
    fill(text.keyName, 'mistral_api_key');
    fill(text.keyValue, API_KEY);
    fireEvent.click(screen.getByRole('button', { name: text.addKey }));
    save();

    expect((await saved(onSave)).providerKeys).toEqual({ MISTRAL_API_KEY: API_KEY });
  });

  it.each(['MISTRAL', '1X_API_KEY', 'MIS-TRAL_API_KEY', '_API_KEY'])(
    'refuses the variable name %j',
    (name) => {
      const { onSave } = renderSetup(EMPTY_SETUP);
      fireEvent.change(field(text.provider), { target: { value: 'other' } });
      fill(text.keyName, name);
      fill(text.keyValue, API_KEY);
      fireEvent.click(screen.getByRole('button', { name: text.addKey }));

      expect(screen.getByText(text.keyNameInvalid)).toBeTruthy();
      expect(screen.queryByRole('list', { name: text.keys })).toBeNull();
      save();
      expect(onSave).not.toHaveBeenCalled();
    },
  );

  it('asks for the key when only the provider was chosen', () => {
    renderSetup(EMPTY_SETUP);
    fireEvent.click(screen.getByRole('button', { name: text.addKey }));

    expect(screen.getByText(text.keyValueMissing)).toBeTruthy();
  });

  it('removes a stored key on save, and can change its mind before', async () => {
    const { onSave } = renderSetup(FILLED_SETUP);
    fireEvent.click(screen.getByRole('button', { name: text.removeKey('OpenAI') }));
    expect(within(keyList()).getByText(text.keyRemoved)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: text.undoKey('OpenAI') }));
    expect(within(keyList()).getByText(text.keyStored)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: text.removeKey('OpenAI') }));
    save();
    expect((await saved(onSave)).providerKeys).toEqual({ OPENAI_API_KEY: null });
  });

  it('replaces a stored key with a new one of the same name', async () => {
    const { onSave } = renderSetup(FILLED_SETUP);
    fireEvent.change(field(text.provider), { target: { value: 'OPENAI_API_KEY' } });
    fill(text.keyValue, API_KEY);
    fireEvent.click(screen.getByRole('button', { name: text.addKey }));

    expect(within(keyList()).getAllByRole('listitem')).toHaveLength(1);
    expect(within(keyList()).getByText(text.keyReplaced)).toBeTruthy();
    save();
    expect((await saved(onSave)).providerKeys).toEqual({ OPENAI_API_KEY: API_KEY });
  });

  it('drops a key added by mistake', async () => {
    const { onSave } = renderSetup(CONFIGURED);
    fill(text.keyValue, API_KEY);
    fireEvent.click(screen.getByRole('button', { name: text.addKey }));
    fireEvent.click(screen.getByRole('button', { name: text.removeKey('Google AI Studio') }));
    save();

    expect((await saved(onSave)).providerKeys).toEqual({});
  });
});

describe('web search on the first setup', () => {
  /** `addWebSearch` answers as the shell's add: `true` when saved, `false` when already there. */
  const firstRun = (addWebSearch: () => Promise<boolean> = async () => true) => {
    const order: string[] = [];
    const onAddWebSearch = vi.fn(async () => {
      order.push('web search');
      return addWebSearch();
    });
    const onSave = vi.fn(async (_input: SetupInput) => {
      order.push('setup');
      return FILLED_SETUP;
    });
    render(
      <SetupScreen
        setup={EMPTY_SETUP}
        onSave={onSave}
        onClose={vi.fn()}
        onAddWebSearch={onAddWebSearch}
      />,
    );
    fill(text.model, 'openai/gpt-5-mini');
    return { order, onAddWebSearch, onSave };
  };
  const checkbox = (): HTMLInputElement => screen.getByRole('checkbox', { name: text.webSearch });

  it('comes checked, with what leaves the Mac beside it', () => {
    firstRun();

    expect(checkbox().checked).toBe(true);
    expect(screen.getByText(strings.connections.webSearchNote)).toBeTruthy();
  });

  it('adds the web search before saving the setup, so the daemon starts once', async () => {
    const { order, onSave } = firstRun();
    save();

    await saved(onSave);
    expect(order).toEqual(['web search', 'setup']);
  });

  it('adds nothing once unchecked', async () => {
    const { onAddWebSearch, onSave } = firstRun();
    fireEvent.click(checkbox());
    save();

    await saved(onSave);
    expect(onAddWebSearch).not.toHaveBeenCalled();
  });

  it('saves nothing and says why when the web search could not be added', async () => {
    const { onSave } = firstRun(async () => {
      throw new Error('mcp.json is not valid JSON');
    });
    save();

    expect(await screen.findByText('mcp.json is not valid JSON')).toBeTruthy();
    expect(screen.getByText(text.rejected)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    expect(checkbox()).toBeTruthy();
  });

  it('says the web search stays on when the setup is then not saved', async () => {
    const { order, onSave } = firstRun();
    onSave.mockImplementation(async () => {
      order.push('setup');
      throw new Error('the Keychain refused the token');
    });
    save();

    expect(await screen.findByText('the Keychain refused the token')).toBeTruthy();
    expect(screen.getByText(text.rejected)).toBeTruthy();
    expect(screen.getByText(text.webSearchKept)).toBeTruthy();
    expect(order).toEqual(['web search', 'setup']);
  });

  it('does not say the web search stays on when it was not added', async () => {
    const { onSave } = firstRun();
    fireEvent.click(checkbox());
    onSave.mockImplementation(async () => {
      throw new Error('the Keychain refused the token');
    });
    save();

    expect(await screen.findByText('the Keychain refused the token')).toBeTruthy();
    expect(screen.queryByText(text.webSearchKept)).toBeNull();
  });

  it('does not say the web search was added when a server already had its name', async () => {
    const { order, onSave } = firstRun(async () => false);
    onSave.mockImplementation(async () => {
      order.push('setup');
      throw new Error('the Keychain refused the token');
    });
    save();

    expect(await screen.findByText('the Keychain refused the token')).toBeTruthy();
    expect(order).toEqual(['web search', 'setup']);
    expect(screen.queryByText(text.webSearchKept)).toBeNull();
  });

  it('is not offered once the setup is complete: Conexiones has it', () => {
    render(
      <SetupScreen
        setup={FILLED_SETUP}
        onSave={vi.fn(async () => FILLED_SETUP)}
        onClose={vi.fn()}
        onAddWebSearch={vi.fn(async () => true)}
      />,
    );

    expect(screen.queryByRole('checkbox', { name: text.webSearch })).toBeNull();
  });
});

describe('the daily limit of AI calls (DK-21)', () => {
  it("sends a limit from 1 to 10000, with today's use and the current limit beside it", async () => {
    const onSave = vi.fn(async (_input: SetupInput) => FILLED_SETUP);
    render(
      <SetupScreen
        setup={CONFIGURED}
        onSave={onSave}
        onClose={() => {}}
        aiUsage={{ calls: 12, limit: 200 }}
      />,
    );
    expect(field(text.aiLimit).placeholder).toBe('200');
    expect(screen.getByText(text.aiLimitHelp)).toBeTruthy();

    fill(text.aiLimit, ' 500 ');
    save();

    expect(await saved(onSave)).toMatchObject({ dailyAiCallLimit: 500 });
  });

  it('leaves the limit out when the field is empty, so the stored one stays', async () => {
    const { onSave } = renderSetup(CONFIGURED);
    save();

    expect('dailyAiCallLimit' in (await saved(onSave))).toBe(false);
  });

  it('refuses a limit that is not a whole number from 1 to 10000, and saves nothing', () => {
    const { onSave } = renderSetup(CONFIGURED);
    for (const typed of ['0', '10001', '2.5', 'mucho']) {
      fill(text.aiLimit, typed);
      save();
      expect(screen.getByText(text.aiLimitInvalid)).toBeTruthy();
    }
    expect(onSave).not.toHaveBeenCalled();
  });
});

// DK-23: the onboarding asks no developer knowledge: models first, providers by name, a key named
// by its provider, and "Probar".
describe('onboarding (DK-23)', () => {
  const picker = (): HTMLSelectElement => screen.getByLabelText(text.modelProvider);
  const pick = (value: string): void => {
    fireEvent.change(picker(), { target: { value } });
  };

  it('asks for the model first and for Telegram last, as optional (AC1)', () => {
    renderSetup(EMPTY_SETUP);
    const groups = screen.getAllByRole('group').map((group) => group.querySelector('legend'));

    expect(groups.at(0)?.textContent).toBe(text.sectionModels);
    expect(groups.at(-1)?.textContent).toBe(text.sectionTelegram);
  });

  it('offers the providers by name and fills in the model suggested for one (AC2)', () => {
    renderSetup(EMPTY_SETUP);
    const options = within(picker()).getAllByRole<HTMLOptionElement>('option');
    expect(options.map((option) => option.textContent)).toEqual([
      text.chooseProvider,
      ...SETUP_PROVIDERS.map((provider) => provider.name),
      text.otherModel,
    ]);

    pick('google');
    expect(field(text.model).value).toBe('google/gemini-2.5-flash');
    expect(field(text.visionModel).value).toBe('google/gemini-2.5-flash');
  });

  it('still takes any model written as provider/model, with "Otro modelo…" (AC2)', async () => {
    const { onSave } = renderSetup(EMPTY_SETUP);
    pick('other');
    fill(text.model, 'groq/llama-3.3-70b-versatile');
    expect(picker().value).toBe('other');
    save();

    expect(onSave).not.toHaveBeenCalled();
    // Nothing says it reads photos: the photo model is asked for, never assumed.
    expect(screen.getByText(text.visionModelMissing)).toBeTruthy();
    expect(field(text.visionModel).getAttribute('aria-invalid')).toBe('true');
    fill(text.visionModel, 'google/gemini-2.5-flash');
    save();

    expect(await saved(onSave)).toMatchObject({
      model: 'groq/llama-3.3-70b-versatile',
      visionModel: 'google/gemini-2.5-flash',
    });
  });

  it('keeps a photo model of its own when a provider is chosen', () => {
    renderSetup(EMPTY_SETUP);
    pick('google');
    pick('openai');
    expect(field(text.visionModel).value).toBe('openai/gpt-5-mini');

    fill(text.visionModel, 'google/gemini-2.5-pro');
    pick('anthropic');
    expect(field(text.model).value).toBe('anthropic/claude-haiku-4-5');
    expect(field(text.visionModel).value).toBe('google/gemini-2.5-pro');
  });

  it('follows a model typed with a provider it offers', () => {
    renderSetup(EMPTY_SETUP);
    fill(text.model, 'anthropic/claude-sonnet-4-5');
    expect(picker().value).toBe('anthropic');
  });

  it('names the key by its provider, never by its variable, and stores it as before (AC3)', async () => {
    const { onSave } = renderSetup(EMPTY_SETUP);
    pick('google');
    const key = field('Clave de Google AI Studio');
    expect(key.type).toBe('password');
    expect(document.body.textContent).not.toContain('_API_KEY');
    fireEvent.change(key, { target: { value: API_KEY } });
    save();

    expect((await saved(onSave)).providerKeys).toEqual({ GEMINI_API_KEY: API_KEY });
  });

  it('shows a stored key of the chosen provider only as stored (AC3)', () => {
    renderSetup(FILLED_SETUP);
    expect(field('Clave de OpenAI').placeholder).toBe(text.keyStoredKeep);
    expect(field('Clave de OpenAI').value).toBe('');
    expect(document.body.textContent).not.toContain('OPENAI_API_KEY');
  });

  it('forgets a key typed for one provider when another is chosen (AC3)', async () => {
    const { onSave } = renderSetup(EMPTY_SETUP);
    pick('google');
    fill('Clave de Google AI Studio', API_KEY);
    pick('openai');
    save();

    expect((await saved(onSave)).providerKeys).toEqual({});
    expect(document.documentElement.outerHTML).not.toContain(API_KEY);
  });

  describe('"Probar" (AC4)', () => {
    const renderProbe = (
      setup: SetupState,
      onProbe?: () => Promise<ProbeOutcome | 'lost'>,
    ): void => {
      render(
        <SetupScreen
          setup={setup}
          onSave={async () => setup}
          onClose={vi.fn()}
          {...(onProbe === undefined ? {} : { onProbe })}
        />,
      );
    };
    const probe = (): HTMLButtonElement => screen.getByRole('button', { name: text.probe });

    it.each<ProbeOutcome>(['ok', 'key_refused', 'budget_exhausted', 'not_connected'])(
      'tests the saved model once and says %s in plain words',
      async (outcome) => {
        const onProbe = vi.fn(async () => outcome);
        renderProbe(FILLED_SETUP, onProbe);
        expect(screen.getByText(text.probeHelp)).toBeTruthy();
        fireEvent.click(probe());

        expect(await screen.findByText(text.probeOutcome[outcome])).toBeTruthy();
        expect(onProbe).toHaveBeenCalledOnce();
      },
    );

    it('says so when the connection was lost before the answer', async () => {
      renderProbe(FILLED_SETUP, async () => 'lost');
      fireEvent.click(probe());

      expect(await screen.findByText(text.probeLost)).toBeTruthy();
    });

    it('takes no second probe while one runs', async () => {
      let finish: (outcome: ProbeOutcome) => void = () => {};
      const onProbe = vi.fn(
        () =>
          new Promise<ProbeOutcome>((resolve) => {
            finish = resolve;
          }),
      );
      renderProbe(FILLED_SETUP, onProbe);
      fireEvent.click(probe());
      const probing = await screen.findByRole<HTMLButtonElement>('button', { name: text.probing });
      expect(probing.disabled).toBe(true);
      fireEvent.click(probing);
      expect(onProbe).toHaveBeenCalledOnce();
      finish('ok');
      expect(await screen.findByText(text.probeOutcome.ok)).toBeTruthy();
    });

    it('cannot test a model or a key that is not saved yet', () => {
      renderProbe(FILLED_SETUP, async () => 'ok');
      fill(text.model, 'openai/gpt-5-mini');
      expect(probe().disabled).toBe(true);
      expect(screen.getByText(text.probeSaveFirst)).toBeTruthy();

      fill(text.model, 'openai/gpt-4o-mini');
      expect(probe().disabled).toBe(false);
      fill('Clave de OpenAI', API_KEY);
      expect(probe().disabled).toBe(true);
    });

    it('says ANOMANDER must be running to test', () => {
      renderProbe(FILLED_SETUP);
      expect(probe().disabled).toBe(true);
      expect(screen.getByText(text.probeNotRunning)).toBeTruthy();
    });
  });
});
