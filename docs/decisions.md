# Decisions and scope

## Out of scope

Out of this first cycle: price tracking, subscriptions, budgets, the bank connection, the web dashboard, the desktop app, voice and computer control. Each one will come in as a new matter that tests the ontology and makes it grow only where needed.

## Size of the ontology

There are 26 classes, but not all of them are stored data:

- **Data (16), what ends up in the database:** principal, external entity (the merchant), document, expense, purchase line, category, observation, declaration, inference, confirmation, matter, pending decision, policy, permission, proposal and action.
- **Vocabulary (10), concepts that guide the design but are not tables:** assertion (the idea shared by observation, declaration, inference and confirmation), source (a field of every assertion), goal and preference (for expenses they fit into policies), pattern (not needed until ANOMANDER proposes rules), capability (lives in the code), execution, working context, processor and provider (runtime concepts).

No trimming is needed: the 10 vocabulary classes cost nothing, and the 16 data classes are what the cycle needs.

## Decisions

- [x] First matter: keeping my expenses.
- [x] Starting permission granted: register without asking if the lines add up to the total and the category comes from one of my policies.
- [x] Initial categories: supermercado and restaurantes. Everything else stays uncategorized until another category is needed.
- [x] Photos: not stored. Only the extracted information matters.
- [x] Model for reading receipts: no preference; by default, an external vision model.
- [x] Ontology: not trimmed; 16 data classes and 10 vocabulary classes.
- [x] Supermarket dashboard data: product, quantity, price, merchant, date and the mode of each expense.
- [x] Stack: TypeScript everywhere; Rust only for the desktop app, with Tauri 2.
- [x] Open-source project, in a public repository.
- [x] License: MIT.
- [x] Repository documentation language: English.
- [x] Lint and format: Biome.
- [x] Docker: the daemon runs in a container; the end-to-end tests run in-process, against a fake Telegram API.
- [x] Tests: unit, property, contract, integration, end to end and a receipt evaluation (see [stack.md](stack.md)).
- [x] Models: first through a subscription or an API; local models later.
- [x] Memory: the SQLite ledger is the only memory. Engram, if used, is a read-only external source; ANOMANDER never writes to it.
- [x] Conversation memory (PRD R-23): captured automatically from each text, used only to converse, listed on request, and erased for real after a confirmation with buttons. Its text lives in `memory_texts` so that forgetting does not touch the append-only ledger.
- [x] Hosting: local during development (M0 to M3) and a VPS with Docker once it is ready to run 24/7.
