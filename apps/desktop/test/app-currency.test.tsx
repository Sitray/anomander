// @vitest-environment jsdom
import { DEFAULT_CURRENCY, getCurrency, setCurrency } from '@anomander/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { type Snapshot, shell } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { FILLED_SETUP, runningSnapshot } from './fixtures.ts';

// B74 (DK-25 AC4): the Gastos screen says a sum of several currencies with the principal's first,
// the principal's being the currency of the setup, as the daemon's is. The whole window against a
// mocked shell: never real Tauri.
vi.mock('../src/shell.ts', () => ({
  shell: {
    snapshot: vi.fn(),
    onSnapshot: vi.fn(),
    onStopTask: vi.fn(),
    onChatShown: vi.fn(),
    setThinking: vi.fn(),
    setTaskRunning: vi.fn(),
  },
}));

const mocked = vi.mocked(shell);
/** Sends the window a snapshot, as the shell's event does. */
let emit: (snapshot: Snapshot) => void;

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  mocked.onSnapshot.mockImplementation(async (handler) => {
    emit = (snapshot) => act(() => handler(snapshot));
    return () => {};
  });
  mocked.onStopTask.mockResolvedValue(() => {});
  mocked.onChatShown.mockResolvedValue(() => {});
  mocked.setThinking.mockResolvedValue(undefined);
  mocked.setTaskRunning.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  // The principal's currency is the protocol's, for the whole process: no test leaves its own.
  setCurrency(DEFAULT_CURRENCY);
});

const expense = (id: number, cents: number, currency: string) => ({
  id,
  date: '2026-11-02',
  merchant: `Comercio ${id}`,
  category: null,
  totalCents: cents,
  currency,
  mode: 'declared' as const,
  categoryMode: null,
  origin: 'text' as const,
  lines: 0,
});

/** Opens Gastos with the setup's `currency`; the daemon answers three currencies, two pending. */
const openExpenses = async (currency: string | null) => {
  mocked.snapshot.mockResolvedValue(runningSnapshot({ setup: { ...FILLED_SETUP, currency } }));
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).not.toBe(strings.status.loading),
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: strings.status.openExpenses }));
  const socket = FakeWebSocket.last;
  act(() => socket.open());
  act(() =>
    socket.receive({
      type: 'expenses',
      inReplyTo: socket.lastRequest.id,
      month: '2026-11',
      expenses: [expense(1, 4520, 'EUR'), expense(2, 1200, 'USD'), expense(3, 300, 'GBP')],
      totals: [
        { cents: 4520, currency: 'EUR' },
        { cents: 1200, currency: 'USD' },
        { cents: 300, currency: 'GBP' },
      ],
      pending: {
        count: 2,
        totals: [
          { cents: 100, currency: 'EUR' },
          { cents: 200, currency: 'USD' },
        ],
      },
    }),
  );
  await screen.findByText(strings.expenses.total);
};

/** The total and the pending note, as the screen says them. */
const said = () => ({
  total: screen.getByText(strings.expenses.total).closest('tr')?.textContent,
  pending: document.querySelector('.expenses-note')?.textContent,
});

const EUR = '45,20 €';
const USD = '12,00 US$';
const GBP = '3,00\u00a0GBP';

describe('the principal currency of the window (B74)', () => {
  it.each([
    ['EUR', `${EUR}, ${GBP} y ${USD}`, `1,00 € y 2,00 US$`],
    ['USD', `${USD}, ${EUR} y ${GBP}`, `2,00 US$ y 1,00 €`],
    ['GBP', `${GBP}, ${EUR} y ${USD}`, `1,00 € y 2,00 US$`],
  ])(
    'says the setup %s first, in the total and in the pending',
    async (currency, total, pending) => {
      await openExpenses(currency);

      expect(said().total).toContain(total);
      expect(said().pending).toContain(pending);
      // Each row stays in its own currency.
      const cells = [...document.querySelectorAll('tbody td.amount')].map(
        (cell) => cell.textContent,
      );
      expect(cells).toEqual([EUR, USD, GBP]);
    },
  );

  // Unset, a code this window does not know, one without cents or one not in upper case (the
  // shell stores codes in upper case): the daemon's default, euros.
  it.each([null, 'XYZ', 'JPY', 'usd'])('says euros first with the setup %s', async (currency) => {
    await openExpenses(currency);

    expect(said().total).toContain(`${EUR}, ${GBP} y ${USD}`);
    expect(getCurrency()).toBe(DEFAULT_CURRENCY);
  });

  it('follows a currency changed while the screen is open', async () => {
    await openExpenses('USD');
    expect(said().total).toContain(`${USD}, ${EUR} y ${GBP}`);

    emit(runningSnapshot({ setup: { ...FILLED_SETUP, currency: 'GBP' } }));
    await act(async () => {});

    expect(said().total).toContain(`${GBP}, ${EUR} y ${USD}`);
    expect(getCurrency()).toBe('GBP');
  });

  it('leaves no principal of its own to the next test', () => {
    expect(getCurrency()).toBe(DEFAULT_CURRENCY);
  });
});
