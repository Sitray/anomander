// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_LABELS } from '../src/login/accounts.ts';
import { SubscriptionsScreen } from '../src/login/SubscriptionsScreen.tsx';
import type { LoginOutcome, LoginStep, SubscriptionsView } from '../src/shell.ts';
import { strings } from '../src/strings.ts';

// DK-15: connecting a subscription (ChatGPT, Kimi Code) from the app. The screen learns which
// accounts are connected and the steps of a login, never a token or an address.
afterEach(cleanup);

const { subscriptions: text } = strings;

const NONE: SubscriptionsView = {
  accounts: [
    { providerId: 'openai', connected: false, login: true },
    { providerId: 'kimi-coding', connected: false, login: true },
    { providerId: 'anthropic', connected: false, login: false },
    { providerId: 'github-copilot', connected: false, login: false },
  ],
};

const connected = (...ids: string[]): SubscriptionsView => ({
  accounts: NONE.accounts.map((account) => ({
    ...account,
    connected: ids.includes(account.providerId),
  })),
});

const renderScreen = async (
  connect: () => Promise<LoginOutcome> = async () => ({ outcome: 'connected' }),
  views: SubscriptionsView[] = [NONE, connected('openai')],
) => {
  let read = 0;
  const load = vi.fn(async () => views[Math.min(read++, views.length - 1)] ?? NONE);
  const onConnect = vi.fn(async (_id: string) => connect());
  const onAnswer = vi.fn(async (_text: string) => {});
  const onDisconnect = vi.fn(async (_id: string) => NONE);
  const onClose = vi.fn();
  let step: (step: LoginStep) => void = () => {};
  const unsubscribe = vi.fn();
  const subscribeSteps = vi.fn((handler: (step: LoginStep) => void) => {
    step = (next) => act(() => handler(next));
    return unsubscribe;
  });
  render(
    <SubscriptionsScreen
      load={load}
      onConnect={onConnect}
      onAnswer={onAnswer}
      onDisconnect={onDisconnect}
      subscribeSteps={subscribeSteps}
      onClose={onClose}
    />,
  );
  await waitFor(() => expect(screen.queryByText(text.loading)).toBeNull());
  return { load, onConnect, onAnswer, onDisconnect, onClose, step: (s: LoginStep) => step(s) };
};

const row = (label: string) =>
  within(screen.getByRole('list', { name: text.accounts }))
    .getAllByRole('listitem')
    .find((item) => item.textContent?.startsWith(label)) as HTMLElement;

const status = () => screen.getByRole('status').textContent;

describe('the Suscripciones screen', () => {
  it('lists the accounts offered for login, each with its state and one Conectar', async () => {
    await renderScreen();

    const chatGpt = row(ACCOUNT_LABELS.openai);
    expect(within(chatGpt).getByText(text.notConnected)).toBeTruthy();
    expect(
      within(chatGpt).getByRole('button', { name: text.connectFor(ACCOUNT_LABELS.openai) }),
    ).toBeTruthy();
    expect(row(ACCOUNT_LABELS['kimi-coding'])).toBeTruthy();
    // Accounts no longer offered for login are only listed while connected (R-27 AC6).
    expect(screen.queryByText(ACCOUNT_LABELS.anthropic)).toBeNull();
    expect(screen.queryByText(ACCOUNT_LABELS['github-copilot'])).toBeNull();
  });

  it('lets an account logged in before be disconnected, and says so', async () => {
    const { onDisconnect } = await renderScreen(undefined, [connected('anthropic', 'openai')]);

    const claude = row(ACCOUNT_LABELS.anthropic);
    expect(within(claude).getByText(text.connected)).toBeTruthy();
    expect(
      within(claude).queryByRole('button', { name: text.connectFor(ACCOUNT_LABELS.anthropic) }),
    ).toBeNull();
    fireEvent.click(
      within(claude).getByRole('button', { name: text.disconnectFor(ACCOUNT_LABELS.anthropic) }),
    );

    await waitFor(() => expect(onDisconnect).toHaveBeenCalledWith('anthropic'));
    await waitFor(() => expect(status()).toBe(text.disconnected(ACCOUNT_LABELS.anthropic)));
    expect(screen.queryByText(ACCOUNT_LABELS.anthropic)).toBeNull();
  });

  it('opens the browser, takes the pasted address for ChatGPT, then says it is connected', async () => {
    let answer: (value: LoginOutcome) => void = () => {};
    const { onConnect, onAnswer, step } = await renderScreen(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );

    fireEvent.click(screen.getByRole('button', { name: text.connectFor(ACCOUNT_LABELS.openai) }));
    expect(onConnect).toHaveBeenCalledWith('openai');
    expect(status()).toBe(text.starting);
    // One login at a time, and no disconnect meanwhile.
    for (const name of [
      text.connectFor(ACCOUNT_LABELS.openai),
      text.connectFor(ACCOUNT_LABELS['kimi-coding']),
    ]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }

    step({ kind: 'opened' });
    expect(status()).toBe(text.opened(ACCOUNT_LABELS.openai));
    expect(screen.queryByLabelText(text.pasteLabel)).toBeNull();

    step({ kind: 'prompt' });
    const field = screen.getByLabelText(text.pasteLabel) as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'http://localhost:1455/auth/callback?code=c' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith('http://localhost:1455/auth/callback?code=c'),
    );
    // Sent once: the field is cleared and nothing of it stays in the window.
    expect(field.value).toBe('');

    answer({ outcome: 'connected' });
    await waitFor(() => expect(status()).toBe(text.outcome.connected(ACCOUNT_LABELS.openai)));
    expect(within(row(ACCOUNT_LABELS.openai)).getByText(text.connected)).toBeTruthy();
    expect(screen.queryByLabelText(text.pasteLabel)).toBeNull();
  });

  it('shows the device code of Kimi Code while the browser waits', async () => {
    const { step } = await renderScreen(() => new Promise(() => {}));

    fireEvent.click(
      screen.getByRole('button', { name: text.connectFor(ACCOUNT_LABELS['kimi-coding']) }),
    );
    step({ kind: 'device_code', code: 'ABCD-1234' });

    expect(status()).toBe(text.deviceCode(ACCOUNT_LABELS['kimi-coding']));
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
  });

  it('an empty paste is not sent', async () => {
    const { onAnswer, step } = await renderScreen(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: text.connectFor(ACCOUNT_LABELS.openai) }));
    step({ kind: 'prompt' });

    const field = screen.getByLabelText(text.pasteLabel) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);

    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText(text.pasteMissing)).toBeTruthy();
  });

  it('says why it did not connect', async () => {
    for (const outcome of ['timed_out', 'cancelled'] as const) {
      await renderScreen(async () => ({ outcome }), [NONE]);
      fireEvent.click(screen.getByRole('button', { name: text.connectFor(ACCOUNT_LABELS.openai) }));
      await waitFor(() => expect(status()).toBe(text.outcome[outcome]));
      expect(screen.queryByText(text.connected)).toBeNull();
      cleanup();
    }
  });

  it('shows what the shell said when the login failed', async () => {
    await renderScreen(async () => {
      throw new Error('login failed: TypeError');
    });
    fireEvent.click(screen.getByRole('button', { name: text.connectFor(ACCOUNT_LABELS.openai) }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text.failed);
    expect(alert.textContent).toContain('login failed: TypeError');
    // The screen is usable again.
    expect(
      (
        screen.getByRole('button', {
          name: text.connectFor(ACCOUNT_LABELS.openai),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('can be left while the browser waits, and stops listening to the steps', async () => {
    const { onClose } = await renderScreen(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: text.connectFor(ACCOUNT_LABELS.openai) }));

    fireEvent.keyDown(screen.getByRole('heading', { name: text.title }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: text.close }));

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('says when the accounts cannot be read, and offers to try again', async () => {
    const load = vi
      .fn<() => Promise<SubscriptionsView>>()
      .mockRejectedValueOnce(new Error('could not read model-login in the Keychain'))
      .mockResolvedValue(NONE);
    render(
      <SubscriptionsScreen
        load={load}
        onConnect={async () => ({ outcome: 'connected' })}
        onAnswer={async () => {}}
        onDisconnect={async () => NONE}
        subscribeSteps={() => () => {}}
        onClose={() => {}}
      />,
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text.loadFailed);
    fireEvent.click(within(alert).getByRole('button', { name: strings.status.retry }));
    await waitFor(() => expect(row(ACCOUNT_LABELS.openai)).toBeTruthy());
  });
});
