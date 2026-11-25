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
  it('says how to bring the file out of Docker, with the commands as a block to copy (S5)', () => {
    renderScreen(async () => ({ outcome: 'imported' }));
    expect(screen.getByText(text.howIntro)).toBeTruthy();
    const block = screen.getByText(text.howCommands, { normalizer: (value) => value });
    expect(block.tagName).toBe('PRE');
    expect(block.classList.contains('code-block')).toBe(true);
    expect(text.howCommands.split('\n')).toEqual([
      'docker compose stop',
      'docker compose cp daemon:/app/data/anomander.db ~/Downloads/anomander.db',
    ]);
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

describe('its words (DK-21)', () => {
  it('speaks of the principal\'s data, never of a "ledger"', () => {
    renderScreen(async () => ({ outcome: 'imported' }));

    expect(document.body.textContent).not.toMatch(/ledger/i);
    const words = (value: unknown): string[] =>
      typeof value === 'string' ? [value] : Object.values(value as object).flatMap(words);
    expect(words(text).filter((line) => /ledger/i.test(line))).toEqual([]);
  });
});

describe('choosing the file (DK-21)', () => {
  const renderWithPicker = (picked: string | null) => {
    const onPick = vi.fn(async () => picked);
    const onImport = vi.fn(async (_path: string) => ({ outcome: 'imported' as const }));
    render(<LedgerScreen onImport={onImport} onClose={() => {}} onPick={onPick} />);
    return { onPick, onImport };
  };

  it('"Elegir archivo…" fills in the path of the file chosen, which is then imported', async () => {
    const { onPick, onImport } = renderWithPicker('/Users/ana/Downloads/anomander.db');
    fireEvent.click(screen.getByRole('button', { name: text.choose }));

    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>(text.path).value).toBe(
        '/Users/ana/Downloads/anomander.db',
      ),
    );
    expect(onPick).toHaveBeenCalledOnce();
    importIt();
    await waitFor(() => expect(onImport).toHaveBeenCalledWith('/Users/ana/Downloads/anomander.db'));
  });

  it('keeps what was typed when nothing is chosen', async () => {
    const { onPick } = renderWithPicker(null);
    type('~/anomander.db');
    fireEvent.click(screen.getByRole('button', { name: text.choose }));

    await waitFor(() => expect(onPick).toHaveBeenCalledOnce());
    expect(screen.getByLabelText<HTMLInputElement>(text.path).value).toBe('~/anomander.db');
  });

  it('offers no chooser where the window cannot open one', () => {
    renderScreen(async () => ({ outcome: 'imported' }));

    expect(screen.queryByRole('button', { name: text.choose })).toBeNull();
  });
});
