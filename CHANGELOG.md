# Changelog

All notable changes to ANOMANDER are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

On `main` since 0.1.0. The interface speaks English or Spanish, and the app runs on macOS and on Windows.

### Added

- **English**: the app's window and the notch speak the system's language (Spanish on a Spanish system, English otherwise). The daemon and Telegram speak the language of `ANOMANDER_LOCALE`, `es` by default or `en`; the app sets it from the system's language.
- **Windows**: the same app, built from this repository, with the chat, the setup, connections, subscription login and Telegram. Secrets go to the Windows Credential Manager; the tray icon shows the working wave and the finished drop appears at the top of the screen; an unsigned NSIS installer. A look at the screen and tasks on the computer stay macOS-only (see [`docs/windows-check.md`](docs/windows-check.md)).
- **Web search by default**: the first setup shows "Búsqueda web" checked, with a note on what leaves the computer.
- **Web search from the chat**: when a request needs web search and it is missing, the chat offers "Añadir búsqueda web". The button adds the connection, waits for the daemon to restart and sends the same text again. Telegram gets the text alone.
- **Daily backup**: right after the retention job, the daemon copies the database beside it as `<db>.backup-daily-<stamp>` (mode 600) once a day and keeps the 7 newest, apart from the copies taken before migrations. Erased conversation and memory text stays in the older copies until 7 newer daily copies replace them (PRD §16).
- **Gastos screen**: the app's window shows the expenses of a month, read only, from the ledger's views: date, merchant, category, amount and how ANOMANDER knows each one ("Me lo dijiste", "Deducido"; a category "deducida" or "por tu regla"), the month's total and the pending ones apart, with the previous and next month a press away (DK-17).
- **Undo or correct a typed expense**: the "Apuntado…" reply of a typed expense carries "Deshacer" and "Corregir", in Telegram and in the app. "Deshacer" takes it out of the ledger; "Corregir" asks what to change and writes it as a new declaration that supersedes the old one. A correction can also be typed, "no eran 23, eran 32", about one of the expenses of the last 30 minutes; when it is not clear which, ANOMANDER asks (PRD R-7 AC4-AC8).
- **Correct or undo from Gastos**: each row of the Gastos screen has "Corregir" and "Deshacer", typed expenses and registered receipts alike. They press the expense's own buttons of the chat: "Deshacer" asks first in the window, then takes the expense out of the ledger; "Corregir" goes to the chat, where the next text is the correction. The press and its reply are kept in the conversation, they wait for the chat's turn, and the list is read again (DK-17 AC6).
- **Memoria** (DK-18): a screen in the app with what ANOMANDER remembers about you, each memory marked "Me lo dijiste" or "Lo deduje", and what it has done for you. Each item has "Olvidar", asked first: a forgotten memory or action is erased for real, with only the messages of the stored conversation that mention it (whole-word match, as for a replaced memory; a reply that said it in other words stays).
- **`/exportar`**: in Telegram, sends the ledger (`gastos`, `lineas_de_compra`, `pendientes_de_confirmar`) as CSV files and `ledger.json`, also kept under `exports/` in the data folder. In the app it says the export comes through Telegram for now (PRD R-29).
- **Expense query**: "¿cuánto llevo gastado este mes?", "¿cuánto gasté en Mercadona en octubre?" get the total, the number of expenses and a breakdown by category (or the top merchants of a category), with the expenses pending confirmation counted apart. The model only picks the period and the filters; code computes every figure from the ledger. In Telegram and in the app (PRD R-30).

- **Your currency** (DK-25): `ANOMANDER_CURRENCY` (ISO 4217, `EUR` by default) is the currency new expenses, typed or from a receipt, are written in (a receipt is never the duplicate of an expense in another currency); the expenses already stored keep theirs, never converted. Every amount is said in its expense's currency (`12,30 US$`, `US$12.30` in English), and a total that holds more than one currency is said per currency (`45,20 € y 12,00 US$`), never added up: the weekly summary, the expense query and the Gastos screen (its total and the pending ones).

### Changed

- The CI workflow runs only by hand while GitHub Actions minutes are unavailable. `scripts/ci-local.sh` runs the same checks locally before a merge to `main`.
- CI also runs Biome, the typecheck and Vitest on Linux (`check-linux`), and starts the built daemon image until its health check says healthy. `scripts/ci-local.sh` runs the same smoke start when Docker is running.
- Dependencies: Dependabot proposes weekly grouped updates for pnpm, Cargo and the GitHub actions; every action is pinned to a commit SHA; CI audits the locked dependencies (`pnpm audit --audit-level high`, `cargo audit`); pnpm installs only versions published at least a day ago (`minimumReleaseAge`). `scripts/ci-local.sh` runs the pnpm audit, and the cargo audit where `cargo-audit` is installed.
- `pnpm coverage` measures the test coverage with Vitest's V8 provider and prints a summary; no thresholds.
- Repository: issue templates (bug, feature), a pull request template that asks for `scripts/ci-local.sh`, `CODEOWNERS`, and `apps/desktop/src-tauri/rust-toolchain.toml` (stable, with clippy and rustfmt). A CI `msrv` job checks the shell on the `rust-version` of its `Cargo.toml`; `scripts/ci-local.sh` runs it where that toolchain is installed.
- The daemon image has a `HEALTHCHECK`: healthy while a daemon holds its database lock. `compose.yaml` rotates the daemon log at 3 files of 10 MB.
- Dependency updates (croner 11, pi-ai 1.6, better-sqlite3 13.2, grammy 1.48, Tauri 2.12.7, getrandom 0.4, Biome 2.6, CI actions). Custom `ANOMANDER_*_CRON` patterns are now parsed strictly: one that was quietly misread before stops the daemon at start with an error. The every-minute tick keeps running through the repeated hour when the clocks go back.

### Fixed

- Several presses of "Añadir búsqueda web" during a daemon restart all wait for the new daemon; before, only one request was kept.
- The check that a task comes from the message keeps English negations and contractions, and locale tags such as `es@euro` count as Spanish.

### Security

- On Windows the daemon runs in a Job Object that ends everything it started when it stops, and the data and log folders are readable by their owner only.
- Web search runs the `pi-web-access` installed with the daemon, its whole dependency tree pinned in `pnpm-lock.yaml`, instead of what `npx` resolves afresh; existing `mcp.json` files need no change.
- The daemon log now also hides model provider keys, connection secrets, the model login and OAuth tokens, and logs a crash scrubbed instead of raw.
- The daemon log also hides a login or OAuth token it gets after its start, a secret written JSON-escaped or URL-encoded, and the provider keys of a crash before the configuration is read; a crash line is written out before the daemon exits.

## [0.1.0] - 2026-11-21

The first tagged version. There is no packaged download: you build and run it from this repository, with Docker or as the Mac app (see the [README](README.md)). In this version the interface is in Spanish only and the Mac app runs on macOS only; English and Windows came later (see [Unreleased](#unreleased)).

### Added

- **Expenses** (PRD M0 to M4): text and receipt expenses, decisions with buttons, corrections, categories and policies, a daily AI call limit, and retention of old receipts.
- **Telegram**: the front door for everything above, plus conversation memory, the weekly summary and the morning digest (off until asked for), reminders and tasks, model login (`/login`) and the setup guide (`/start`) (M5).
- **Read API**: a token-guarded, GET-only HTTP API over the views `gastos`, `lineas_de_compra` and `pendientes_de_confirmar`, off unless `ANOMANDER_API_TOKEN` is set (M5b).
- **Mac app** (M6, [`docs/desktop-prd.md`](docs/desktop-prd.md)):
  - Chat and setup, with model keys and the Telegram bot token in the macOS Keychain. Telegram is optional.
  - A menu bar wave while ANOMANDER works, and a drop from the notch when it ends.
  - No mode buttons: from your words the daemon decides whether to look at the screen, act on the computer or use your connections.
  - A look at the screen, never stored.
  - Tasks on the computer, one step at a time. A step of care waits for "Permitir"; before a click, Return or Space the app reads the real element on screen, and some apps (System Settings, Keychain Access, password managers) are never touched.
  - Connections to MCP servers, with OAuth for servers reached by URL: one "Conectar" for Notion, Linear and Atlassian, or any server by hand. A tool marked read-only runs; any other call waits for "Permitir".
  - Web search through a pinned `pi-web-access` connection; reading a page asks first.
  - Memories and a local history of what it did, erased on request.
  - Subscription login for ChatGPT and Kimi Code.
  - Ledger import from a Docker install.
  - Rotating, scrubbed log files and "Copiar diagnóstico" in the menu.

### Security

- Secrets reach the daemon over stdin, not the environment.
- Bot, API and local channel tokens are scrubbed from logs.
- The read API needs a token of 32 characters or more, refuses an address off the machine unless allowed, and slows down repeated wrong tokens.
- The database is backed up before a migration, and a database from a newer build is left untouched.
- Each app window can call only the commands it uses.
