// DK-17: the expenses of a month, over the `gastos` and `pendientes_de_confirmar` views. The
// container asks the daemon; `ExpensesTable` only shows what it answered. AC6: each row's
// "Corregir" and "Deshacer" press the expense's own buttons of the chat (R-7 AC4 to AC8).
import {
  type ChatExpense,
  type ChatExpenses,
  formatAmount,
  formatDate,
  strings as replies,
} from '@anomander/protocol';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { LocalChannel } from '../shell.ts';
import { strings } from '../strings.ts';
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons.tsx';
import { shiftMonth, useExpenses } from './use-expenses.ts';

const { expenses: text } = strings;

export interface ExpensesScreenProps {
  /** `null` while the daemon is not running. */
  channel: LocalChannel | null;
  onClose: () => void;
  /** AC6: the daemon stored a row's press and its reply in the conversation; the chat follows. */
  onAmended?: () => void;
  /** AC6: "Corregir" was asked what to change (S-7): the principal answers in the chat. */
  onCorrecting?: () => void;
}

export function ExpensesScreen({ channel, onClose, onAmended, onCorrecting }: ExpensesScreenProps) {
  const { state, month, current, show, retry, amend } = useExpenses(channel);
  const heading = useRef<HTMLHeadingElement>(null);
  /** The expense whose "Deshacer" was pressed, waiting for "Sí, deshacer". */
  const [asking, setAsking] = useState<number | null>(null);
  const [amending, setAmending] = useState(false);
  /** What the last press got: the daemon's reply, or why there is none. */
  const [note, setNote] = useState<string | null>(null);
  const question = useId();

  // The screen replaces the chat: start reading it from its title.
  useEffect(() => heading.current?.focus(), []);

  const press = async (action: 'undo' | 'correct', expenseId: number) => {
    setAmending(true);
    setNote(null);
    const outcome = await amend(action, expenseId);
    setAmending(false);
    setAsking(null);
    if (outcome === 'not_sent' || outcome === 'unknown') {
      setNote(outcome === 'unknown' ? text.amendUnknown : text.amendNotSent);
      if (outcome === 'unknown') onAmended?.();
      return;
    }
    setNote(outcome.text);
    onAmended?.();
    // R-7 AC6: the next text is the correction, written in the chat.
    if (action === 'correct' && outcome.text === replies.askCorrection()) onCorrecting?.();
  };

  /** A row's "Corregir" and "Deshacer", or the question "Deshacer" opened. */
  const rowAction = (expense: ChatExpense): ReactNode => {
    const amount = formatAmount(expense.totalCents);
    const date = formatDate(expense.date);
    if (asking === expense.id) {
      return (
        <span className="memory-confirm">
          <span id={question}>{text.confirmUndo}</span>
          <button
            type="button"
            className="link"
            aria-describedby={question}
            disabled={amending}
            onClick={() => void press('undo', expense.id)}
          >
            {text.confirmYes}
          </button>
          <button
            type="button"
            className="link"
            aria-describedby={question}
            // biome-ignore lint/a11y/noAutofocus: the button it replaces had the focus.
            autoFocus
            disabled={amending}
            onClick={() => setAsking(null)}
          >
            {text.keep}
          </button>
        </span>
      );
    }
    return (
      <span className="expenses-actions">
        <button
          type="button"
          className="link"
          aria-label={text.correctLabel(amount, date)}
          disabled={amending}
          onClick={() => void press('correct', expense.id)}
        >
          {text.correct}
        </button>
        <button
          type="button"
          className="link"
          aria-label={text.undoLabel(amount, date)}
          disabled={amending}
          onClick={() => {
            setNote(null);
            setAsking(expense.id);
          }}
        >
          {text.undo}
        </button>
      </span>
    );
  };

  const title = month === null ? '' : text.month(month);
  return (
    <section
      className="setup expenses-screen"
      aria-labelledby="expenses-title"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || amending) return;
        if (asking !== null) setAsking(null);
        else onClose();
      }}
    >
      <div className="setup-body">
        <div className="setup-intro">
          <h2 ref={heading} id="expenses-title" tabIndex={-1}>
            {text.title}
          </h2>
          <p>{text.intro}</p>
        </div>

        {state.kind === 'closed' ? (
          <p className="expenses-note">{text.closed}</p>
        ) : (
          <div className="expenses">
            <div className="expenses-month">
              <button
                type="button"
                className="icon-button"
                aria-label={text.previous}
                title={text.previous}
                disabled={month === null}
                onClick={() => month !== null && show(shiftMonth(month, -1))}
              >
                <ChevronLeftIcon />
              </button>
              <h3 aria-live="polite">{title}</h3>
              <button
                type="button"
                className="icon-button"
                aria-label={text.next}
                title={text.next}
                disabled={month === null || current === null || month >= current}
                onClick={() => month !== null && show(shiftMonth(month, 1))}
              >
                <ChevronRightIcon />
              </button>
            </div>

            {state.kind === 'loading' && (
              <p className="expenses-note" role="status">
                {text.loading}
              </p>
            )}
            {state.kind === 'failed' && (
              <div className="setup-alert" role="alert">
                <p>{text.failed}</p>
                <button type="button" className="button" onClick={retry}>
                  {text.retry}
                </button>
              </div>
            )}
            {note !== null && (
              <p className="expenses-note" role="status">
                {note}
              </p>
            )}
            {state.kind === 'shown' && (
              <ExpensesTable answer={state.answer} rowAction={rowAction} />
            )}
          </div>
        )}
      </div>

      <footer className="setup-footer">
        <div className="setup-actions">
          <button type="button" className="button" onClick={onClose}>
            {strings.setup.close}
          </button>
        </div>
      </footer>
    </section>
  );
}

export interface ExpensesTableProps {
  answer: ChatExpenses;
  /** AC6: the actions of each row, "Corregir" and "Deshacer". Absent, there is no column for them. */
  rowAction?: (expense: ChatExpense) => ReactNode;
}

/** Presentational: one month as the daemon answered it. */
export function ExpensesTable({ answer, rowAction }: ExpensesTableProps) {
  const month = text.month(answer.month);
  return (
    <>
      {answer.expenses.length === 0 ? (
        <p className="expenses-note">{text.empty(month)}</p>
      ) : (
        <table className="expenses-table">
          <caption className="sr-only">{text.caption(month)}</caption>
          <thead>
            <tr>
              <th scope="col">{text.date}</th>
              <th scope="col">{text.merchant}</th>
              <th scope="col">{text.category}</th>
              <th scope="col" className="amount">
                {text.amount}
              </th>
              <th scope="col">{text.mode}</th>
              {rowAction !== undefined && (
                <th scope="col">
                  <span className="sr-only">{text.actions}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {answer.expenses.map((expense) => (
              <tr key={expense.id}>
                <td>
                  <time dateTime={expense.date}>{formatDate(expense.date)}</time>
                </td>
                <td>
                  {expense.merchant ?? <span className="expenses-none">{text.noMerchant}</span>}
                  {expense.lines > 0 && (
                    <span className="expenses-lines">{text.lines(expense.lines)}</span>
                  )}
                </td>
                <td>
                  {expense.category ?? <span className="expenses-none">{text.noCategory}</span>}
                  {(expense.categoryMode === 'inferred' || expense.categoryMode === 'policy') && (
                    <span className="mode-tag category-mode" data-mode={expense.categoryMode}>
                      {text.categoryModes[expense.categoryMode]}
                    </span>
                  )}
                </td>
                <td className="amount">{formatAmount(expense.totalCents)}</td>
                <td>
                  <span className="mode-tag" data-mode={expense.mode}>
                    {text.modes[expense.mode]}
                  </span>
                </td>
                {rowAction !== undefined && <td>{rowAction(expense)}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3}>
                {text.total}
              </th>
              <td className="amount">{formatAmount(answer.totalCents)}</td>
              <td colSpan={rowAction === undefined ? 1 : 2} />
            </tr>
          </tfoot>
        </table>
      )}
      {answer.pending.count > 0 && (
        <p className="expenses-note">
          {text.pending(answer.pending.count, formatAmount(answer.pending.totalCents))}
        </p>
      )}
    </>
  );
}
