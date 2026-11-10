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
    fill(text.model, 'openai/gpt-4o-mini');
    save();

    expect(await screen.findByText(text.savedIncomplete)).toBeTruthy();
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
    const { onSave } = renderSetup(EMPTY_SETUP);
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
    const { onSave } = renderSetup(EMPTY_SETUP);
    fill(text.keyValue, API_KEY);
    save();

    expect((await saved(onSave)).providerKeys).toEqual({ OPENAI_API_KEY: API_KEY });
  });

  it('takes another provider by the name of its variable', async () => {
    const { onSave } = renderSetup(EMPTY_SETUP);
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
    const { onSave } = renderSetup(EMPTY_SETUP);
    fill(text.keyValue, API_KEY);
    fireEvent.click(screen.getByRole('button', { name: text.addKey }));
    fireEvent.click(screen.getByRole('button', { name: text.removeKey('OPENAI_API_KEY') }));
    save();

    expect((await saved(onSave)).providerKeys).toEqual({});
  });
});
