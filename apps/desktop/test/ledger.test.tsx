// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerScreen } from '../src/ledger/LedgerScreen.tsx';
import type { LedgerImport, LedgerOutcome } from '../src/shell.ts';
import { strings } from '../src/strings.ts';

// DK-12: the import of a ledger brought from a Docker install.
afterEach(cleanup);

const { ledger: text } = strings;

const renderScreen = (answer: () => Promise<LedgerImport>) => {
  const onImport = vi.fn(async (_path: string) => answer());
  const onClose = vi.fn();
  render(<LedgerScreen onImport={onImport} onClose={onClose} />);
  return { onImport, onClose };
};

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText(text.path), { target: { value } });
const importIt = () => fireEvent.click(screen.getByRole('button', { name: text.import }));
const status = () => screen.getByRole('status');

describe('the ledger import', () => {
  it('says how to bring the file out of Docker', () => {
    renderScreen(async () => ({ outcome: 'imported' }));
    expect(screen.getByText(text.how)).toBeTruthy();
  });

  it('sends the path as typed and says it was imported', async () => {
    const { onImport } = renderScreen(async () => ({ outcome: 'imported' }));
    type('  ~/Downloads/anomander.db ');
    importIt();

    await waitFor(() => expect(status().textContent).toBe(text.outcome.imported));
    expect(onImport).toHaveBeenCalledWith('~/Downloads/anomander.db');
  });

  it('says what each refusal means', async () => {
    const refusals: LedgerOutcome[] = [
      'missing',
      'same_file',
      'not_a_ledger',
      'newer_ledger',
      'damaged',
      'daemon_running',
      'own_has_expenses',
      'not_a_path',
    ];
    for (const outcome of refusals) {
      renderScreen(async () => ({ outcome }));
      type('/Users/p/anomander.db');
      importIt();
      await waitFor(() => expect(status().textContent).toBe(text.outcome[outcome]));
      cleanup();
    }
  });

  it('sends nothing without a full path, and says why', () => {
    const { onImport } = renderScreen(async () => ({ outcome: 'imported' }));
    importIt();
    expect(screen.getByText(text.pathMissing)).toBeTruthy();
    type('Downloads/anomander.db');
    importIt();
    expect(screen.getByText(text.pathNotFull)).toBeTruthy();
    expect(onImport).not.toHaveBeenCalled();
  });

  it('shows what the shell said when it failed, and that the ledger did not change', async () => {
    renderScreen(async () => {
      throw new Error('could not import the ledger: EACCES');
    });
    type('/Users/p/anomander.db');
    importIt();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text.failed);
    expect(alert.textContent).toContain('EACCES');
  });

  it('asks once at a time, and says the daemon is stopped meanwhile', async () => {
    let answer: (value: LedgerImport) => void = () => {};
    const { onImport } = renderScreen(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    type('/Users/p/anomander.db');
    importIt();
    expect(status().textContent).toBe(text.importing);
    importIt();
    expect(onImport).toHaveBeenCalledOnce();
    answer({ outcome: 'imported' });
    await waitFor(() => expect(status().textContent).toBe(text.outcome.imported));
  });

  it('closes on its button', () => {
    const { onClose } = renderScreen(async () => ({ outcome: 'imported' }));
    fireEvent.click(screen.getByRole('button', { name: strings.setup.close }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
