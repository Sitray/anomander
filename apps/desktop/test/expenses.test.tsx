// @vitest-environment jsdom
import {
  type ChatExpenses,
  type ChatRequest,
  formatAmount,
  formatDate,
  strings as replies,
} from '@anomander/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpensesScreen } from '../src/expenses/ExpensesScreen.tsx';
import type { LocalChannel } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { CHANNEL, replyTo } from './fixtures.ts';

// DK-17 (docs/desktop-prd.md): the "Gastos" screen, read only, over the local channel.
const text = strings.expenses;

const NOVEMBER: Omit<ChatExpenses, 'inReplyTo'> = {
  type: 'expenses',
  month: '2026-11',
  expenses: [
    {
      id: 1,
      date: '2026-11-02',
      merchant: null,
      category: 'restaurantes',
      totalCents: 2300,
      mode: 'declared',
      categoryMode: 'inferred',
      origin: 'text',
      lines: 0,
    },
    {
      id: 2,
      date: '2026-11-15',
      merchant: 'Café Sol',
      category: 'restaurantes',
      totalCents: 300,
      mode: 'inferred',
      categoryMode: 'policy',
      origin: 'receipt',
      lines: 3,
    },
  ],
  totalCents: 2600,
  pending: { count: 2, totalCents: 1500 },
};
const OCTOBER: Omit<ChatExpenses, 'inReplyTo'> = {
  ...NOVEMBER,
  month: '2026-10',
  expenses: [],
  totalCents: 0,
  pending: { count: 0, totalCents: 0 },
};

let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  onClose = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The screen with its connection open. */
const show = (channel: LocalChannel | null = CHANNEL) => {
  render(<ExpensesScreen channel={channel} onClose={onClose} />);
  if (channel === null) return undefined;
  const socket = FakeWebSocket.last;
  act(() => socket.open());
  return socket;
};

/** The daemon answers the last request with `answer`; returns that request. */
const answer = async (
  socket: FakeWebSocket,
  month: Omit<ChatExpenses, 'inReplyTo'>,
): Promise<ChatRequest> => {
  const request = socket.lastRequest;
  await act(async () => socket.receive({ ...month, inReplyTo: request.id }));
  return request;
};

const rows = () => within(screen.getByRole('table')).getAllByRole('row');

describe('the expenses screen (DK-17)', () => {
  it('asks for the current month and shows its expenses, the total by code and the pending apart', async () => {
    const socket = show() as FakeWebSocket;
    expect(socket.lastRequest).toEqual({ type: 'expenses', id: expect.any(String) });

    await answer(socket, NOVEMBER);

    expect(screen.getByRole('heading', { name: text.month('2026-11') })).toBeTruthy();
    const [header, cena, cafe, total] = rows();
    expect(within(header as HTMLElement).getAllByRole('columnheader')).toHaveLength(5);
    expect(cena?.textContent).toContain(formatDate('2026-11-02'));
    expect(cena?.textContent).toContain(text.noMerchant);
    expect(cena?.textContent).toContain(formatAmount(2300));
    expect(cafe?.textContent).toContain('Café Sol');
    expect(cafe?.textContent).toContain(text.lines(3));
    expect(total?.textContent).toContain(formatAmount(2600));
    // The amount's no-break space would be normalized away by a text query.
    expect(document.body.textContent).toContain(text.pending(2, formatAmount(1500)));
    // Read only: correcting comes with B20, so no row offers a button yet.
    expect(within(screen.getByRole('table')).queryAllByRole('button')).toEqual([]);
  });

  it('shows how ANOMANDER knows each expense: "deducido" on an inferred one', async () => {
    await answer(show() as FakeWebSocket, NOVEMBER);

    const [, cena, cafe] = rows();
    const cells = (row: HTMLElement | undefined) => within(row as HTMLElement).getAllByRole('cell');
    // The expense's own mode, from the view's `modo`.
    expect(cells(cafe)[4]?.textContent).toBe(text.modes.inferred);
    expect(cells(cena)[4]?.textContent).toBe(text.modes.declared);
    // The category's, from `category_basis`: typed, yet its category was inferred.
    expect(cells(cena)[2]?.textContent).toBe(`restaurantes${text.categoryModes.inferred}`);
    expect(cells(cafe)[2]?.textContent).toBe(`restaurantes${text.categoryModes.policy}`);
  });

  it('moves to the previous month and back, never past the current one', async () => {
    const socket = show() as FakeWebSocket;
    await answer(socket, NOVEMBER);
    const next = screen.getByRole('button', { name: text.next }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: text.previous }));
    expect(await answer(socket, OCTOBER)).toMatchObject({ type: 'expenses', month: '2026-10' });
    expect(screen.getByRole('heading', { name: text.month('2026-10') })).toBeTruthy();
    expect(next.disabled).toBe(false);

    fireEvent.click(next);
    expect(await answer(socket, NOVEMBER)).toMatchObject({ type: 'expenses', month: '2026-11' });
    expect(screen.getByRole('heading', { name: text.month('2026-11') })).toBeTruthy();
  });

  it('says so when a month has no expenses', async () => {
    await answer(show() as FakeWebSocket, OCTOBER);

    expect(screen.getByText(text.empty(text.month('2026-10')))).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.body.textContent).not.toContain(text.pending(0, formatAmount(0)));
  });

  it('says it could not load them when the daemon fails, and asks again on Reintentar', async () => {
    const socket = show() as FakeWebSocket;
    const request = socket.lastRequest;
    await act(async () =>
      socket.receive(replyTo(request.id, { text: replies.processingFailed() })),
    );

    expect(screen.getByRole('alert').textContent).toContain(text.failed);
    fireEvent.click(screen.getByRole('button', { name: text.retry }));
    expect(socket.requests).toHaveLength(2);
    await answer(socket, NOVEMBER);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rows()).toHaveLength(4);
  });

  it('with the channel closed, says ANOMANDER is not running and asks nothing', () => {
    show(null);

    expect(screen.getByText(text.closed)).toBeTruthy();
    expect(FakeWebSocket.instances).toEqual([]);
  });

  it('closes back to the chat with Escape', () => {
    show();
    fireEvent.keyDown(screen.getByRole('heading', { name: text.title }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
