# Changelog

All notable changes to ANOMANDER are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-21

The first tagged version. There is no packaged download: you build and run it from this repository, with Docker or as the Mac app (see the [README](README.md)). The interface is in Spanish only, and the Mac app runs on macOS only.

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
