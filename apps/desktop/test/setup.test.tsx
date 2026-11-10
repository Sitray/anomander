// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { strings } from '../src/strings.ts';
import { renderApp } from './harness.tsx';
import { shellMock } from './shell-mock.ts';
import { notConfigured, running } from './snapshots.ts';

vi.mock('../src/shell.ts', async () => ({ shell: (await import('./shell-mock.ts')).shellMock }));

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const fill = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: strings.save }));
const openSettings = () => fireEvent.click(screen.getByRole('button', { name: strings.settings }));

describe('setup (DK-5 AC1)', () => {
  it('opens by itself when the daemon is not configured', async () => {
    await renderApp(notConfigured());

    expect(screen.getByRole('heading', { name: strings.setupTitle })).toBeTruthy();
    expect(field(strings.botTokenLabel).type).toBe('password');
  });

  it('sends what was typed, the bot token included', async () => {
    await renderApp(notConfigured());

    fill(strings.botTokenLabel, '123456:ABC-secret');
    fill(strings.chatIdLabel, '4242');
    fill(strings.modelLabel, 'openai/gpt-4o-mini');
    fill(strings.visionModelLabel, 'openai/gpt-4o');
    save();

    await waitFor(() => expect(shellMock.saveSetup).toHaveBeenCalledTimes(1));
    expect(shellMock.saveSetup).toHaveBeenCalledWith({
      telegramBotToken: '123456:ABC-secret',
      principalChatId: '4242',
      model: 'openai/gpt-4o-mini',
      visionModel: 'openai/gpt-4o',
      providerKeys: {},
    });
  });

  it('shows a stored bot token as stored and leaves it out when not typed', async () => {
    await renderApp(running());
    openSettings();

    expect(field(strings.botTokenLabel).value).toBe('');
    expect(screen.getByText(strings.botTokenStored)).toBeTruthy();
    expect(field(strings.chatIdLabel).value).toBe('4242');
    save();

    await waitFor(() => expect(shellMock.saveSetup).toHaveBeenCalledTimes(1));
    expect(shellMock.saveSetup.mock.calls[0]?.[0]).not.toHaveProperty('telegramBotToken');
  });

  it('refuses a chat ID that is not digits and a model that is not provider/model', async () => {
    await renderApp(running());
    openSettings();

    fill(strings.chatIdLabel, '@principal');
    fill(strings.modelLabel, 'gpt-4o-mini');
    save();

    expect(await screen.findByText(strings.chatIdInvalid)).toBeTruthy();
    expect(screen.getByText(strings.modelInvalid)).toBeTruthy();
    expect(shellMock.saveSetup).not.toHaveBeenCalled();
  });

  it('asks for the bot token when none is stored', async () => {
    await renderApp(notConfigured());

    fill(strings.chatIdLabel, '4242');
    save();

    expect(await screen.findByText(strings.botTokenRequired)).toBeTruthy();
    expect(shellMock.saveSetup).not.toHaveBeenCalled();
  });

  it('lists stored keys by name only, removes one and adds another', async () => {
    await renderApp(running());
    openSettings();

    expect(within(screen.getByRole('list')).getByText('OPENAI_API_KEY')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: strings.removeKey('OPENAI_API_KEY') }));
    fireEvent.change(screen.getByLabelText(strings.keyVariableLabel), {
      target: { value: 'ANTHROPIC_API_KEY' },
    });
    fill(strings.keyValueLabel, 'sk-ant-secret');
    fireEvent.click(screen.getByRole('button', { name: strings.addKey }));

    expect(document.body.textContent).not.toContain('sk-ant-secret');
    expect(field(strings.keyValueLabel).value).toBe('');
    save();
    await waitFor(() => expect(shellMock.saveSetup).toHaveBeenCalledTimes(1));
    expect(shellMock.saveSetup.mock.calls[0]?.[0].providerKeys).toEqual({
      OPENAI_API_KEY: null,
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    });
  });

  it('takes another *_API_KEY variable and refuses a name that is not one', async () => {
    await renderApp(running());
    openSettings();
    fireEvent.change(screen.getByLabelText(strings.keyVariableLabel), { target: { value: '' } });

    fill(strings.keyVariableCustomLabel, 'MISTRAL_TOKEN');
    fill(strings.keyValueLabel, 'secret');
    fireEvent.click(screen.getByRole('button', { name: strings.addKey }));
    expect(screen.getByText(strings.keyVariableInvalid)).toBeTruthy();

    fill(strings.keyVariableCustomLabel, 'MISTRAL_API_KEY');
    fireEvent.click(screen.getByRole('button', { name: strings.addKey }));
    expect(within(screen.getByRole('list')).getByText('MISTRAL_API_KEY')).toBeTruthy();
  });

  it('forgets every typed secret once it saved', async () => {
    await renderApp(notConfigured());
    shellMock.saveSetup.mockResolvedValue(running());
    fill(strings.botTokenLabel, '123456:ABC-secret');
    fill(strings.chatIdLabel, '4242');
    fill(strings.keyValueLabel, 'sk-typed-not-added');
    save();

    await waitFor(() => expect(shellMock.saveSetup).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: strings.setupTitle })).toBeNull(),
    );
    openSettings();
    expect(field(strings.botTokenLabel).value).toBe('');
    expect(field(strings.keyValueLabel).value).toBe('');
  });

  it('goes back to the chat without saving', async () => {
    await renderApp(running());
    openSettings();

    fireEvent.click(screen.getByRole('button', { name: strings.back }));

    expect(screen.queryByRole('heading', { name: strings.setupTitle })).toBeNull();
    expect(shellMock.saveSetup).not.toHaveBeenCalled();
  });
});
