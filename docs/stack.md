# Stack and providers

TypeScript everywhere until the desktop phase; Rust only for the desktop app, just as gentle-dot does. Everything in this document is a replaceable implementation: the ontology depends on none of it.

## Where gentle-dot uses Rust

Checked by cloning the repository. It has about 22,000 lines of Rust, all in one place: `apps/desktop/src-tauri`, the desktop app built with Tauri 2. It is the part that touches the operating system:

| Rust module | Lines (approx.) | Purpose |
| --- | --- | --- |
| `computer` | 6,200 | Computer control: see the screen, click, type |
| `voice` | 4,100 | Local speech with Parakeet through sherpa-onnx |
| `daemon` | 3,100 | Start and supervise the Node daemon |
| `secure_store` | 1,700 | Keep secrets in the macOS Keychain |
| `approvals` | 650 | Approval dialogs, out of the agent's reach |
| Rest | | Global shortcuts, menu bar icon, windows |

The rest of the project, about 42,000 lines, is TypeScript: `packages/daemon` (the Node daemon that runs the engine over RPC), `packages/protocol` (the WebSocket protocol types) and `packages/ui` (React with Vite).

The lesson for ANOMANDER: Rust where the operating system is touched, and approval dialogs in native code, where the model cannot reach. None of that is needed before the desktop phase.

## ANOMANDER's stack

| Piece | Choice | Why |
| --- | --- | --- |
| Language | TypeScript, Node 24 | The maintainer's daily stack; the same as gentle-dot's daemon |
| Monorepo | pnpm workspaces | Separate packages with clear boundaries |
| Core | Plain TypeScript with Zod, no provider dependencies | The ontology, truth and authority must not depend on any app or model |
| Store | SQLite with better-sqlite3 | One file, no server |
| Processor | pi-ai (`@earendil-works/pi-ai`), with no tools | API, subscription or local models through the same interface; unlike the coding-agent SDK, it has no shell or file tools |
| Telegram | grammY | Typed, lightweight, supports buttons and photos |
| Tests | Vitest, fast-check | See below |
| Lint and format | Biome | One tool for linting and formatting, as in gentle-dot |
| Containers | Docker and Docker Compose | Same environment locally and on the server |
| Desktop (final phase) | Tauri 2 with Rust | As in gentle-dot |

Repository layout:

```
anomander/
├── docs/               # these documents
├── odd/tasks/          # ODD feature documents (local only, git-ignored)
├── packages/core       # ontology, truth and authority; imports no provider
├── packages/daemon     # runtime: processors, providers and the cycle of each matter
├── packages/protocol   # types shared between the daemon and the front doors
├── apps/telegram       # the first front door
└── apps/desktop        # later: Tauri 2 and Rust
```

One rule is enforced by a test: `packages/core` cannot import anything from `packages/daemon`, from any app or from any provider SDK; it imports only its own files and `zod`. It is a package-boundary test like the one in pi-subagent (`package-boundary.test.ts`).

## Tests and Docker

Each layer of the ontology is tested with the kind of test that fits it:

| Type | What it proves | Example |
| --- | --- | --- |
| Unit (Vitest) | The core rules, with no network or database | An inference is never confirmed without a confirmation or a corroboration; the processor cannot create permissions |
| Property (fast-check) | Rules that must hold for any input | For any generated receipt, the consistency check accepts if and only if the lines add up to the total |
| Contract | That each provider fulfils the interface of its capability | The receipt reader returns inferences with a basis, never observations; uses recorded responses, without calling the model |
| Integration | The core with a real SQLite database in a temporary file | A correction creates a new assertion that refutes the earlier one; the dashboard view returns its columns |
| End to end (in-process) | The full cycle, from the message to the record | A photo sent to a fake Telegram API ends up in `supermarket_purchases` |
| Receipt evaluation | How well the processor reads real receipts | A folder of receipts with their expected total and lines; measures the share read correctly when the model or prompt changes |
| Text evaluation | How well the processor interprets real messages | A list of messages with the expected kind and fields; each case runs several times and passes only if every run does |

The receipt and text evaluations are not pass/fail tests: they are measurements. It decides with data whether a new model (or a local one) reads as well as the current one.

**Docker:** a `Dockerfile` for the daemon and a `compose.yaml` with the daemon and a volume for the SQLite file. The end-to-end tests do not use it: they run in-process with `pnpm test`, with the real bot, daemon and SQLite file against a server that fakes the Telegram API, which covers the full cycle in seconds. Checking that the container builds and starts belongs with the deployment to the VPS.

## Providers and processes

| What is needed | Initial implementation | What it cannot do |
| --- | --- | --- |
| Read documents | A vision model as processor; OCR (for example Tesseract) as an alternative or second opinion | Register anything: it only returns inferences |
| Understand, classify and write | An LLM processor through the Pi SDK; the model is interchangeable (API, subscription or local) | Create observations, confirmations, permissions or matters |
| Consult and inform the principal | Telegram with grammY, with buttons for decisions | Decide what is sent: it only transports |
| Check consistency, authority and retain | Our own code, outside the processor | Delegate to the model |
| Store the truth | SQLite, with mode, source, basis, validity and status as columns of every assertion; photos are not stored | Mix modes in one table without telling them apart |
| Physical process | One Node process and one SQLite file | Anything more until a real matter asks for it |

Receipts are read by default with an external vision model, because it reads crooked or crumpled photos best. Since the photo is deleted afterwards, it only leaves the server while it is being read. Switching to a local model is a provider decision: the ontology does not change.

**Models:** first through a subscription or an API key, chosen at install time; no model is hard-coded. Local models come later, for example served by Ollama on another machine and reached over a private network.

**Hosting:** locally with `docker compose up` during development, and a small VPS with Docker and a persistent volume once it should run 24/7. Telegram long polling needs no public URL or open port.

**Who else uses this data.** The supermarket dashboard in the app of apps is just another consumer: it reads supermarket expenses with their purchase lines, and they show up there automatically once registered. The dashboard does not decide what is true: it shows each expense with its mode and marks as pending those not yet confirmed or corroborated. The ontology is the contract between ANOMANDER and any app that reads its data.

**Where pi and Engram fit:**

- **pi** is not the core. It is the processor: it receives context and returns inferences and proposals. It is given no tools (PRD R-14 AC3); every proposal it returns goes through the authority check, in code, before anything runs.
- **Engram** is not ANOMANDER's memory. The SQLite ledger is the only memory, with full-text search through SQLite FTS5 in the same file. If ANOMANDER ever reads what the principal's coding agents stored in Engram, it does so read-only, and each item enters the ledger as an assertion with source `engram` and the mode it deserves (usually inferred). ANOMANDER never writes to Engram, so personal data such as expenses never ends up in coding-agent memory.
