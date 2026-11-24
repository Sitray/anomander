// DK-17: the expenses of a month, read only, over the `gastos` and `pendientes_de_confirmar`
// views. The container asks the daemon; `ExpensesTable` only shows what it answered.
import { type ChatExpense, type ChatExpenses, formatAmount, formatDate } from '@anomander/protocol';
import { type ReactNode, useEffect, useRef } from 'react';
import type { LocalChannel } from '../shell.ts';
import { strings } from '../strings.ts';
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons.tsx';
import { shiftMonth, useExpenses } from './use-expenses.ts';

const { expenses: text } = strings;

export interface ExpensesScreenProps {
  /** `null` while the daemon is not running. */
  channel: LocalChannel | null;
  onClose: () => void;
}

export function ExpensesScreen({ channel, onClose }: ExpensesScreenProps) {
  const { state, month, current, show, retry } = useExpenses(channel);
  const heading = useRef<HTMLHeadingElement>(null);

  // The screen replaces the chat: start reading it from its title.
  useEffect(() => heading.current?.focus(), []);

  const title = month === null ? '' : text.month(month);
  return (
    <section
      className="setup expenses-screen"
      aria-labelledby="expenses-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
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
            {state.kind === 'shown' && <ExpensesTable answer={state.answer} />}
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
  /**
   * DK-17 AC6 (pending): the action of each row, "Corregir" once the correction of a typed
   * expense (B20) exists. Absent, the table has no column for it and offers no button.
   */
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
