# Changelog

All notable changes to ANOMANDER are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

On `main` since 0.1.0. The interface speaks English or Spanish, and the app runs on macOS and on Windows.

### Added

- **Downloads** (B11): each `vX.Y.Z` tag gets a GitHub release with the Mac app for Apple silicon (`ANOMANDER-<version>-macos-arm64.zip`) and the Windows installer, each with its SHA-256. The app carries the daemon, its production dependencies and the Node that runs it (24.22.3, its download checked against a pinned SHA-256), so it needs no checkout, Node or pnpm; a build from source still runs the checkout's daemon. Unsigned: the Mac app is signed ad hoc, so macOS asks once in Privacidad y seguridad ("Abrir igualmente") and Windows in SmartScreen ("Ejecutar de todas formas"), and macOS asks for the keychain password again after each update. `scripts/release.sh` builds, signs and uploads the Mac app from a clean worktree of the tag; `.github/workflows/release.yml`, run by a pushed tag only, adds the Windows installer. No notarization, no automatic updates.
- **"Permitir siempre" on a connection**: a call of a task with connections that asks also offers "Permitir siempre", in the app and in Telegram. The next calls of that tool of that server run without asking, until "Quitar" under the server in Conexiones, or until the server is removed or its command, arguments, environment or URL changes. The question now says the call in one plain line above its exact arguments (DK-24).
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
- **Reminders and summaries in the app** (DK-22): what ANOMANDER sends unasked (reminders, the morning digest, the weekly summary, the questions about a receipt) also reaches the app while it is connected: it shows in the chat with its buttons and as a system notification. Telegram still gets it as before; it is kept once in the conversation. Without Telegram it waits until the app connects.
- **Notifications: show content or notify only** (DK-22): the setup screen has "Notificaciones", "Mostrar contenido" (the default, as before) or "Solo avisar", which shows "ANOMANDER tiene algo para ti" and nothing of the message, so no amount or memory shows on a locked screen. It applies to every notification of the app and is saved at once.
- **Expense query**: "¿cuánto llevo gastado este mes?", "¿cuánto gasté en Mercadona en octubre?" get the total, the number of expenses and a breakdown by category (or the top merchants of a category), with the expenses pending confirmation counted apart. The model only picks the period and the filters; code computes every figure from the ledger. In Telegram and in the app (PRD R-30).
- **Examples in the empty chat**: it says what ANOMANDER does and offers five examples (an expense query, a reminder, a look at the screen, a web search, "¿Qué sabes de mí?"); a press fills the composer and sends nothing (desktop DK-19).
- **Plain replies with addresses that open**: ANOMANDER is asked to answer in plain text, without Markdown. In the app, each web address of a reply and each link button opens in the browser (only absolute `http` and `https` addresses; anything else stays text) (desktop DK-19).
- **The chat says what it is doing**: while an answer is owed it says "Pensando…", "Leyendo el ticket…", "Mirando tu pantalla…", "Buscando en internet…" or "Usando tus conexiones…", announced to screen readers. "Detener", or Esc, stops a text or a look: the model call is aborted and a task with connections stops before its next step; what was already done stays, and the reply says so. Esc also stops a task on the computer (desktop DK-19).
- **Shortcuts**: Cmd+Shift+Space (Ctrl+Shift+Space on Windows) opens the chat from any app and hides it again; Cmd+, (Ctrl+, on Windows) opens the setup. A hotkey another app holds is skipped and the app works without it (DK-20). Adds `tauri-plugin-global-shortcut` 2.4.1, used by the shell only.
- **Windows wording**: on Windows the window speaks of the Credential Manager and "este equipo", never of macOS, the Keychain or System Settings; a look at the screen or a task on the computer answers "Eso todavía no puedo hacerlo en Windows." instead of the macOS permission message (DK-20).
- **Today's AI calls**: the setup screen shows "Hoy: 12 de 200 llamadas a la IA", the processor calls counted today against `ANOMANDER_DAILY_AI_CALL_LIMIT`, asked of the daemon with the local channel's `ai_usage`. "Límite diario de llamadas a la IA" changes the limit, from 1 to 10000; it applies on restart (DK-21 AC1).
- **Choose the data file**: the import of a Docker install's data has "Elegir archivo…", the system's file dialog showing SQLite files. New dependency: `tauri-plugin-dialog` 2.8.4 and `@tauri-apps/plugin-dialog` 2.8.4, with only `dialog:allow-open` granted (DK-21 AC6).
- **Reading the chat**: every message shows when it was sent, has a "Copiar mensaje" button, and "Buscar en la conversación" marks the matches in the loaded conversation, ignoring case and accents (DK-21 AC5).
- **Onboarding without developer knowledge** (DK-23): the setup screen asks for the model first and Telegram last; "Proveedor del modelo" lists the providers by name with a suggested model, "Otro modelo…" still takes any `provider/model`; the key is named by its provider ("Clave de Google AI Studio"), never by its variable, and stored as before; "Probar" makes one real call to the saved model (counted against the daily AI budget) and says how it went in plain words, never with the provider's text, which can quote the key. While setup is incomplete, the app's chat says to open Configuración instead of `.env` and `/login`; Telegram's guide is unchanged. "Modelo para fotos" left empty is saved as the model when that is a suggested one, known to read photos; otherwise it is asked for.

- **Your currency** (DK-25): `ANOMANDER_CURRENCY` (ISO 4217 with two decimals, `EUR` by default) is the currency new expenses, typed or from a receipt, are written in (a receipt is never the duplicate of an expense in another currency); the expenses already stored keep theirs, never converted. Every amount is said in its expense's currency (`12,30 US$`, `US$12.30` in English), and a total that holds more than one currency is said per currency (`45,20 € y 12,00 US$`), never added up. The app's first setup proposes the system's time zone and the currency of its region, both editable in Configuración (an install set up before keeps the machine's clock and euros until you choose); they apply when ANOMANDER starts again, which saving does. Sums are per currency in the weekly summary, the expense query and the Gastos screen (its total and the pending ones).

### Changed

- The chat's "Adjuntar fotos" takes only images: a PDF or another file stays out of the draft with a message, instead of being sent and refused (DK-21 AC2). The model's name under the composer opens the setup (AC3). The window speaks of "tus datos" instead of a "ledger", and of services instead of MCP servers, `mcp.json`, a proxy or a package (AC4).
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
