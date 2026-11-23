// @vitest-environment jsdom
import { getLocale, setLocale } from '@anomander/protocol';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseLocale } from '../src/locale.ts';
import { SubscriptionsScreen } from '../src/login/SubscriptionsScreen.tsx';
import { mountNotice, noticeText } from '../src/notch/notice.ts';
import { strings } from '../src/strings.ts';

// S4: the window speaks the language the shell chose for it, or the browser's when the shell
// said nothing (a browser, the demo). Spanish stays the default for every other test.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.__ANOMANDER_LOCALE__;
  document.documentElement.lang = '';
  document.body.innerHTML = '';
  setLocale('es');
});

const systemLanguage = (tag: string) => vi.spyOn(navigator, 'language', 'get').mockReturnValue(tag);

describe('the language of the window', () => {
  it('is the one the shell chose, over the browser’s', () => {
    systemLanguage('es-ES');
    window.__ANOMANDER_LOCALE__ = 'en';
    expect(chooseLocale()).toBe('en');
    expect(getLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');

    systemLanguage('en-US');
    window.__ANOMANDER_LOCALE__ = 'es';
    expect(chooseLocale()).toBe('es');
    expect(getLocale()).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });

  it('is the browser’s when the shell said nothing: Spanish for Spanish, English otherwise', () => {
    systemLanguage('es-419');
    expect(chooseLocale()).toBe('es');
    expect(getLocale()).toBe('es');
    expect(document.documentElement.lang).toBe('es');

    systemLanguage('fr-FR');
    expect(chooseLocale()).toBe('en');
    expect(getLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('the window in English', () => {
  it('shows a screen in English, even one whose text was read before the language was chosen', async () => {
    setLocale('en');
    render(
      <SubscriptionsScreen
        load={async () => ({
          accounts: [{ providerId: 'openai', connected: false, login: true }],
        })}
        onConnect={async () => ({ outcome: 'connected' })}
        onAnswer={async () => {}}
        onDisconnect={async () => ({ accounts: [] })}
        subscribeSteps={() => () => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.queryByText('Reading…')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Subscriptions' })).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(strings.status.running).toBe('Running');
  });

  it('says in the notch that the work has ended', () => {
    setLocale('en');
    const root = document.createElement('div');
    document.body.append(root);
    const notice = mountNotice(root, () => {});
    notice.show({ say: 'done', bar: 37, floating: false });
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Finished');
    expect(root.querySelector('.pill')?.getAttribute('aria-label')).toBe('Open the ANOMANDER chat');
    expect(noticeText.open).toBe('Open the ANOMANDER chat');
  });
});
