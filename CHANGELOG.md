# Changelog

All notable changes to ANOMANDER are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

On `main` since 0.1.0. The interface speaks English or Spanish, and the app runs on macOS and on Windows.

### Added

- **English**: the app's window and the notch speak the system's language (Spanish on a Spanish system, English otherwise). The daemon and Telegram speak the language of `ANOMANDER_LOCALE`, `es` by default or `en`; the app sets it from the system's language.
- **Windows**: the same app, built from this repository, with the chat, the setup, connections, subscription login and Telegram. Secrets go to the Windows Credential Manager; the tray icon shows the working wave and the finished drop appears at the top of the screen; an unsigned NSIS installer. A look at the screen and tasks on the computer stay macOS-only (see [`docs/windows-check.md`](docs/windows-check.md)).
- **Web search by default**: the first setup shows "Búsqueda web" checked, with a note on what leaves the computer.
- **Web search from the chat**: when a request needs web search and it is missing, the chat offers "Añadir búsqueda web". The button adds the connection, waits for the daemon to restart and sends the same text again. Telegram gets the text alone.

### Changed

- The CI workflow runs only by hand while GitHub Actions minutes are unavailable. `scripts/ci-local.sh` runs the same checks locally before a merge to `main`.
- CI also runs Biome, the typecheck and Vitest on Linux (`check-linux`), and starts the built daemon image until its health check says healthy. `scripts/ci-local.sh` runs the same smoke start when Docker is running.
- Dependencies: Dependabot proposes weekly grouped updates for pnpm, Cargo and the GitHub actions; every action is pinned to a commit SHA; CI audits the locked dependencies (`pnpm audit --audit-level high`, `cargo audit`); pnpm installs only versions published at least a day ago (`minimumReleaseAge`). `scripts/ci-local.sh` runs the pnpm audit, and the cargo audit where `cargo-audit` is installed.
- The daemon image has a `HEALTHCHECK`: healthy while a daemon holds its database lock. `compose.yaml` rotates the daemon log at 3 files of 10 MB.

### Fixed

- Several presses of "Añadir búsqueda web" during a daemon restart all wait for the new daemon; before, only one request was kept.
- The check that a task comes from the message keeps English negations and contractions, and locale tags such as `es@euro` count as Spanish.

### Security

- On Windows the daemon runs in a Job Object that ends everything it started when it stops, and the data and log folders are readable by their owner only.
- The daemon log now also hides model provider keys, connection secrets, the model login and OAuth tokens, and logs a crash scrubbed instead of raw.

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
