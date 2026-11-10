# Ledger read access (M5b): draft PRD

Status: draft for the principal to correct. Once approved, its requirements move into `PRD.md`
as R-29 onwards under milestone M5b, and this file is removed.

## 1. Problem

Expenses and receipt lines already live in the SQLite database, but the only way to look at
them is Telegram (one reply at a time, the weekly summary) or opening the file by hand. The
principal wants other applications to read them: first a dashboard, a module of the principal's
"app of apps" (G3), which runs on another machine than ANOMANDER.

The app of apps is a separate, private product that also hosts apps unrelated to ANOMANDER. This
document covers only ANOMANDER's side: what it offers to read. The dashboard itself is specified
in the app of apps.

## 2. Goals

- RA-G1. Any application the principal authorizes can read expenses and purchase lines, from
  another machine, without knowing the internal schema.
- RA-G2. Every row carries the mode of its expense, so a reader can tell what is confirmed from
  what is only inferred (§7), and pending expenses are counted apart.
- RA-G3. Keep the daemon's guarantees: readers never write, and the data never leaves the
  principal's machines.

## 3. Non-goals (v1)

- Writing anything. Corrections, confirmations and deletions stay in Telegram, where the
  authority check runs (R-6).
- An MCP server for AI assistants. It comes later, as a layer over the same queries as the API
  (decision 2); v1 is the HTTP API only.
- Reminders, tasks and memories. v1 is about money.
- Several users, or public internet access.

## 4. Principles it must keep

- **Readers see only views.** No reader touches the tables (`docs/data-model.md`): the views of
  RA-1 are the whole contract, so the internal schema can change.
- **No public port.** §20 of `PRD.md`: any web front door goes behind authentication. v1 binds
  to the local machine or a private network only.
- **Mode is always there.** No row is served without the mode of its expense.
- **Money in cents.** Readers format it themselves.

## 5. Requirements (draft)

Every date below is a calendar day in `TZ`, as for the weekly summary (R-10). Pending and
refuted expenses are never served as expenses; pending ones are counted apart (RA-1 AC3).

- RA-1 Views. New read-only views, columns in Spanish like `supermarket_purchases` (R-11):
  - `gastos`: one row per current expense: `id`, `fecha`, `comercio`, `categoria`,
    `total_cents`, `modo`, `origen` (`texto` or `ticket`).
  - `lineas_de_compra`: one row per purchase line of a current expense, any category:
    `gasto_id`, `producto`, `cantidad`, `precio_cents`, `comercio`, `categoria`, `fecha`,
    `modo`.
  - `pendientes_de_confirmar`: the count and total of `pending` expenses.
  `supermarket_purchases` stays as it is.
  - AC1: "23 € cena" gives one `gastos` row with `total_cents = 2300`, `modo = 'declared'`
    and `origen = 'texto'`, and no `lineas_de_compra` row. A receipt gives `origen = 'ticket'`
    and one `lineas_de_compra` row per line, whose `gasto_id` is the expense's `id`.
  - AC2: an expense with no merchant or no category is still listed, with `comercio` or
    `categoria` `NULL`.
  - AC3: `pending` and `refuted` expenses appear in neither `gastos` nor `lineas_de_compra`;
    two pending expenses of 10,00 € and 5,00 € give `pendientes_de_confirmar` a count of 2 and a
    total of 1500.
- RA-2 Read API. The daemon serves the views of RA-1 over HTTP, read only.
  - AC1: it is off by default: with no `ANOMANDER_API_TOKEN` in `.env`, the daemon opens no
    port.
  - AC2: every request without `Authorization: Bearer <ANOMANDER_API_TOKEN>`, or with another
    token, gets `401` and no data. The token is compared in constant time and never logged.
  - AC3: it binds to `127.0.0.1` unless `ANOMANDER_API_HOST` names another address, such as
    the private network's.
  - AC4: it offers only `GET`. Any other method gets `405`, and the database is unchanged.
  - AC5: `GET /v1/gastos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD`,
    `GET /v1/lineas?desde=…&hasta=…&producto=…` and `GET /v1/pendientes` return the matching
    view rows as JSON. Response bodies are never logged.
  - AC6: the queries behind each endpoint live in one place in the daemon, so the later MCP
    server (decision 2) exposes the same ones instead of writing its own.

## 6. Decisions

1. **How readers reach the data.** Decided (2026-11-10): through an HTTP API, not the SQLite
   file. The dashboard runs on another machine, and SQLite's WAL mode does not work over a
   network filesystem.
2. **API or MCP.** Decided (2026-11-10): the HTTP API now, for programs such as the app of
   apps. An MCP server for AI assistants comes later, over the same queries (RA-2 AC6).
3. **How other machines reach the API.** Open, left for last: a private network such as
   Tailscale, or an SSH tunnel.

## 7. Milestone

M5b Ledger read access: the views of RA-1 and the read API of RA-2. The dashboard is built
afterwards in the app of apps, against this API.
