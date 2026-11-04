# Dashboard: draft PRD

Status: draft for the principal to correct. Once approved, its requirements move into `PRD.md`
as R-29 onwards and a roadmap milestone, and this file is removed.

## 1. Problem

Expenses, receipt lines, reminders and memories already live in the SQLite database, but the
only way to look at them is Telegram (one reply at a time, the weekly summary) or opening the
file by hand. The principal wants to see the whole picture at a glance: where the money goes,
how it changes month to month, and what they buy at the supermarket and at what price.

## 2. Goals

- D-G1. See spending per month, per category and per merchant, with the trend of recent months.
- D-G2. See every receipt with its lines (product, quantity, price) and drill into one product's
  price over time, across merchants (the purchase lines already feed this, G3).
- D-G3. Tell at a glance what is confirmed and what is only inferred: every figure carries the
  mode of the expenses behind it, and pending expenses are counted apart (§7).
- D-G4. Keep the daemon's guarantees: the dashboard never writes, and the data never leaves the
  principal's machines.

## 3. Non-goals (v1)

- Editing anything. Corrections, confirmations and deletions stay in Telegram, where the
  authority check runs (R-6). The dashboard is read-only.
- Several users, sharing, or public internet access.
- Budgets, alerts, bank connections, exports (later matters, §17 of `PRD.md`).
- Reminders, tasks and memories. They may come later; v1 is about money.

## 4. Principles it must keep

- **Reads only views.** The dashboard never touches the tables (`docs/data-model.md`): new
  read-only views are its whole contract, so the internal schema can change.
- **No public port.** §20 of `PRD.md`: any web front door goes behind authentication. v1 binds
  to the local machine or a private network only.
- **Mode is visible.** An inferred figure is never shown as if it were confirmed.
- **Money in cents** until it is shown, formatted as in §12 (`23,40 €`).

## 5. Requirements (draft)

- D-1 Views. New read-only views, columns in Spanish like `supermarket_purchases` (R-11):
  - `gastos`: one row per current expense: `fecha`, `comercio`, `categoria`, `total_cents`,
    `modo`, `origen` (`texto` or `ticket`).
  - `lineas_de_compra`: one row per purchase line of a current expense, any category:
    `producto`, `cantidad`, `precio_cents`, `comercio`, `categoria`, `fecha`, `modo`.
  - `pendientes_de_confirmar`: the count and total of `pending` expenses.
  `supermarket_purchases` stays as it is.
- D-2 Overview page: the selected month's total, a bar per category (highest first,
  `Sin clasificar` last, as in R-10 AC4), the last 6 months' totals, and the pending count.
- D-3 Expenses page: the month's expenses, newest first, filterable by category and merchant;
  each row opens its lines when it came from a receipt.
- D-4 Products page: products bought, searchable; a product shows its price per purchase over
  time and per merchant.
- D-5 Every total states how much of it is in each mode (`declared`, `inferred`,
  `corroborated`, `confirmed`).
- D-6 It is a separate app, outside the daemon (decision 1). It reads ANOMANDER's database and
  only through the views of D-1; it never imports daemon code.
- D-7 It opens the database read-only, so a bug in it cannot change the ledger, and it tolerates
  the daemon writing at the same time (SQLite WAL readers).
- D-8 Access: bound to `127.0.0.1` by default and protected by a token. Reaching it from another
  device goes through a private network or an SSH tunnel, never a public port.

## 6. Open decisions

1. **Where it runs.** Decided (2026-11-03): a separate app that reads ANOMANDER's database.
   Still open: whether it opens the SQLite file read-only (same machine, the Docker volume
   mounted read-only) or reads the same views through an API (M5b), which also works from
   another machine and for other apps.
2. **How it is reached from the phone.** A private network such as Tailscale, an SSH tunnel, or
   only on the server's machine.
3. **Stack.** Recommended: server-rendered pages with a small chart library, no build step.
   Alternative: a React app in `apps/dashboard`, heavier but richer.
4. **Product names.** The same product reads differently across receipts ("LECHE ENTERA 1L",
   "Leche entera"). v1 shows them as read; grouping them is a later matter.

## 7. Milestone

M7 Dashboard, a separate app, planned in its own session. ANOMANDER's side is D-1 (the views)
and, if the app reads through an API, M5b.
