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
let onAmended: ReturnType<typeof vi.fn<() => void>>;
let onCorrecting: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  onClose = vi.fn();
  onAmended = vi.fn();
  onCorrecting = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The screen with its connection open. */
const show = (channel: LocalChannel | null = CHANNEL) => {
  render(
    <ExpensesScreen
      channel={channel}
      onClose={onClose}
      onAmended={onAmended}
      onCorrecting={onCorrecting}
    />,
  );
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
/** What the screen says, as it says it: a text query would normalize the amount's no-break space. */
const notes = () => screen.queryAllByRole('status').map((note) => note.textContent);

describe('the expenses screen (DK-17)', () => {
  it('asks for the current month and shows its expenses, the total by code and the pending apart', async () => {
    const socket = show() as FakeWebSocket;
    expect(socket.lastRequest).toEqual({ type: 'expenses', id: expect.any(String) });

    await answer(socket, NOVEMBER);

    expect(screen.getByRole('heading', { name: text.month('2026-11') })).toBeTruthy();
    const [header, cena, cafe, total] = rows();
    expect(cena?.textContent).toContain(formatDate('2026-11-02'));
    expect(cena?.textContent).toContain(text.noMerchant);
    expect(cena?.textContent).toContain(formatAmount(2300));
    expect(cafe?.textContent).toContain('Café Sol');
    expect(cafe?.textContent).toContain(text.lines(3));
    expect(total?.textContent).toContain(formatAmount(2600));
    // The amount's no-break space would be normalized away by a text query.
    expect(document.body.textContent).toContain(text.pending(2, formatAmount(1500)));
    // DK-17 AC6: each row offers "Corregir" and "Deshacer", in a column of its own.
    expect(within(header as HTMLElement).getAllByRole('columnheader')).toHaveLength(6);
    expect(
      within(cena as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([text.correct, text.undo]);
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

// DK-17 AC6: "Corregir" and "Deshacer" on a row press the expense's own buttons of B20 (R-7 AC4 to
// AC8) through the daemon; the chat shows the press and its reply, and the list is read again.
describe('"Corregir" and "Deshacer" on a row (DK-17 AC6)', () => {
  const S100 = replies.undoneNoMerchant(2300);
  const S7 = replies.askCorrection();
  const S19 = replies.decisionClosed();
  const undoOf = (date: string) => text.undoLabel(formatAmount(2300), formatDate(date));
  const correctOf = (date: string) => text.correctLabel(formatAmount(2300), formatDate(date));

  /** The screen showing November. */
  const shown = async () => {
    const socket = show() as FakeWebSocket;
    await answer(socket, NOVEMBER);
    return socket;
  };

  it('"Deshacer" asks first; "No deshacer" sends nothing', async () => {
    const socket = await shown();

    fireEvent.click(screen.getByRole('button', { name: undoOf('2026-11-02') }));
    expect(screen.getByText(text.confirmUndo)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text.keep }));

    expect(screen.queryByText(text.confirmUndo)).toBeNull();
    expect(socket.requests).toHaveLength(1);
    // Escape closes the question, not the screen.
    fireEvent.click(screen.getByRole('button', { name: undoOf('2026-11-02') }));
    fireEvent.keyDown(screen.getByRole('button', { name: text.keep }), { key: 'Escape' });
    expect(screen.queryByText(text.confirmUndo)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Sí, deshacer" sends undo_expense, shows the reply, reads the month again and the chat follows', async () => {
    const socket = await shown();

    fireEvent.click(screen.getByRole('button', { name: undoOf('2026-11-02') }));
    fireEvent.click(screen.getByRole('button', { name: text.confirmYes }));
    const request = socket.lastRequest;
    expect(request).toEqual({ type: 'undo_expense', id: expect.any(String), expenseId: 1 });
    await act(async () => socket.receive(replyTo(request.id, { text: S100 })));

    expect(notes()).toContain(S100);
    // The row and its buttons are gone: reading goes on from the screen's title.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: text.title }));
    expect(socket.lastRequest).toEqual({ type: 'expenses', id: expect.any(String) });
    expect(onAmended).toHaveBeenCalledOnce();
    expect(onCorrecting).not.toHaveBeenCalled();
  });

  it('"Corregir" sends correct_expense and, asked what to change (S-7), goes to the chat', async () => {
    const socket = await shown();

    fireEvent.click(screen.getByRole('button', { name: correctOf('2026-11-02') }));
    const request = socket.lastRequest;
    expect(request).toEqual({ type: 'correct_expense', id: expect.any(String), expenseId: 1 });
    await act(async () => socket.receive(replyTo(request.id, { text: S7 })));

    expect(onAmended).toHaveBeenCalledOnce();
    expect(onCorrecting).toHaveBeenCalledOnce();
  });

  it('an expense no longer current gets S-19: it stays here, says so and reads the month again', async () => {
    const socket = await shown();

    fireEvent.click(screen.getByRole('button', { name: correctOf('2026-11-02') }));
    await act(async () => socket.receive(replyTo(socket.lastRequest.id, { text: S19 })));

    expect(notes()).toContain(S19);
    expect(onCorrecting).not.toHaveBeenCalled();
    expect(socket.lastRequest).toEqual({ type: 'expenses', id: expect.any(String) });
  });

  it('when the daemon fails (S-22) it says so and the row stays', async () => {
    const socket = await shown();

    fireEvent.click(screen.getByRole('button', { name: undoOf('2026-11-02') }));
    fireEvent.click(screen.getByRole('button', { name: text.confirmYes }));
    const failed = replies.processingFailed();
    await act(async () => socket.receive(replyTo(socket.lastRequest.id, { text: failed })));

    expect(notes()).toContain(failed);
    await answer(socket, NOVEMBER);
    expect(rows()).toHaveLength(4);
  });

  it('a request the daemon rejected says it could not be done, never that it is not connected', async () => {
    const socket = await shown();

    fireEvent.click(screen.getByRole('button', { name: correctOf('2026-11-02') }));
    await act(async () => socket.receive({ type: 'rejected', inReplyTo: socket.lastRequest.id }));

    expect(notes()).toContain(text.amendFailed);
    expect(notes()).not.toContain(text.amendNotSent);
    expect(onCorrecting).not.toHaveBeenCalled();
  });

  it('while it waits for the daemon the buttons do nothing, and a lost connection says it cannot know', async () => {
    const socket = await shown();

    fireEvent.click(screen.getByRole('button', { name: correctOf('2026-11-02') }));
    const buttons = within(screen.getByRole('table')).getAllByRole('button') as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await act(async () => socket.drop());

    expect(notes()).toContain(text.amendUnknown);
    expect(onCorrecting).not.toHaveBeenCalled();
  });
});
