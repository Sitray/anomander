// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(within(stored).getByText('OPENAI_API_KEY')).toBeTruthy();
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
      timeZone: 'Europe/Madrid',
      currency: 'EUR',
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
      model: 'openai/gpt-4o-mini',
    }));
    fill(text.model, 'openai/gpt-4o-mini');
    save();

    const input = await saved(onSave);
    expect(input).toEqual({
      principalChatId: '',
      model: 'openai/gpt-4o-mini',
      visionModel: '',
      providerKeys: {},
      timeZone: expect.any(String),
      currency: expect.any(String),
    });
    // Saved and able to start: nothing is said to be missing.
    await waitFor(() => expect(field(text.model).value).toBe('openai/gpt-4o-mini'));
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

  it('offers the usual providers', () => {
    renderSetup(EMPTY_SETUP);
    const options = within(field(text.provider)).getAllByRole<HTMLOptionElement>('option');

    expect(options.map((option) => option.value)).toEqual([
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'other',
    ]);
  });

  it('stores an added key, never showing its value', async () => {
    const { onSave } = renderSetup(CONFIGURED);
    fireEvent.change(field(text.provider), { target: { value: 'ANTHROPIC_API_KEY' } });
    fill(text.keyValue, API_KEY);
    expect(field(text.keyValue).type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: text.addKey }));

    expect(within(keyList()).getByText('ANTHROPIC_API_KEY')).toBeTruthy();
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

    expect((await saved(onSave)).providerKeys).toEqual({ OPENAI_API_KEY: API_KEY });
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
    fireEvent.click(screen.getByRole('button', { name: text.removeKey('OPENAI_API_KEY') }));
    expect(within(keyList()).getByText(text.keyRemoved)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: text.undoKey('OPENAI_API_KEY') }));
    expect(within(keyList()).getByText(text.keyStored)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: text.removeKey('OPENAI_API_KEY') }));
    save();
    expect((await saved(onSave)).providerKeys).toEqual({ OPENAI_API_KEY: null });
  });

  it('replaces a stored key with a new one of the same name', async () => {
    const { onSave } = renderSetup(FILLED_SETUP);
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
    fireEvent.click(screen.getByRole('button', { name: text.removeKey('OPENAI_API_KEY') }));
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
    fill(text.model, 'openai/gpt-4o-mini');
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

// DK-25 AC5: the time zone and the currency, proposed from this system while none is stored.
describe('the time zone and the currency (DK-25)', () => {
  const region = strings.region;
  const select = (label: string): HTMLSelectElement => screen.getByLabelText(label);
  const choose = (label: string, value: string): void => {
    fireEvent.change(select(label), { target: { value } });
  };

  afterEach(() => vi.restoreAllMocks());

  it('proposes the system zone and the currency of its region, and saves them', async () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...real.call(this), timeZone: 'America/Mexico_City' };
    });
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-MX');
    const { onSave } = renderSetup(CONFIGURED);

    expect(select(region.timeZone).value).toBe('America/Mexico_City');
    expect(select(region.currency).value).toBe('MXN');
    expect(screen.getByText(region.help)).toBeTruthy();
    save();

    expect(await saved(onSave)).toMatchObject({
      timeZone: 'America/Mexico_City',
      currency: 'MXN',
    });
  });

  it('shows a stored choice over what the system says, and a save keeps it unchanged', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-MX');
    const { onSave } = renderSetup({ ...FILLED_SETUP, timeZone: 'Asia/Tokyo', currency: 'JPY' });

    expect(select(region.timeZone).value).toBe('Asia/Tokyo');
    expect(select(region.currency).value).toBe('other');
    expect(field(region.currencyCode).value).toBe('JPY');
    save();

    expect(await saved(onSave)).toMatchObject({ timeZone: 'Asia/Tokyo', currency: 'JPY' });
  });

  it('shows the stored ones; any other ISO 4217 code goes under "Otra"', async () => {
    const { onSave } = renderSetup(FILLED_SETUP);
    expect(select(region.timeZone).value).toBe('Europe/Madrid');
    expect(select(region.currency).value).toBe('EUR');

    choose(region.timeZone, 'Asia/Tokyo');
    choose(region.currency, 'other');
    fill(region.currencyCode, ' jpy ');
    save();

    expect(await saved(onSave)).toMatchObject({ timeZone: 'Asia/Tokyo', currency: 'JPY' });
  });

  it('refuses a currency code that does not exist, and saves nothing', () => {
    const { onSave } = renderSetup(FILLED_SETUP);
    choose(region.currency, 'other');
    fill(region.currencyCode, 'XYZ');
    save();

    expect(screen.getByText(region.currencyInvalid)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
});
