# Contributing

ANOMANDER is built with [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) and its Organic Driven Development (ODD) workflow. The [PRD](PRD.md) is the source of truth, and the ontology in [`docs/`](docs) is the public specification: every contribution must respect it.

## Workflow

1. **Start from the PRD.** Every change traces to numbered requirements (`R-#`) and, for user-facing text, to the verbatim strings in PRD §12. If a change needs a new requirement, update the PRD first.
2. **One feature document per milestone.** Substantial work gets `odd/tasks/<feature-name>.md` before the first source write (PRD §18). It is a local working note: `odd/` is git-ignored and never committed. Its `## Specs` quote the relevant `R-#`, their acceptance criteria and the §12 strings verbatim; `## Log` starts with the request that opened it.
3. **Test first.** Write the failing test for an acceptance criterion, watch it fail for the right reason, then make it pass.
4. **Commit in reviewable units** of about 400 changed lines, with tests and docs next to the behaviour, using [Conventional Commits](https://www.conventionalcommits.org/).
5. **Keep the design order.** World and ontology, then truth and authority, then capabilities, then providers. Never let a provider define a capability.

## Checks

Every change must pass:

```sh
pnpm biome check .
pnpm -r typecheck
pnpm test
```

Later milestones add `pnpm test:e2e` and `pnpm eval:receipts` (PRD §15).

## Rules that are easy to break

- `packages/core` imports nothing outside itself except the packages its boundary test allows (PRD R-15 AC2).
- Nothing personal goes in the repository: expenses, categories, policies and permissions live in the local database, and secrets live in `.env`.
- The processor only returns inferences and proposals. Only core code writes to the database.

## Requirements

Node 24 (see `.node-version`), pnpm (the version in `package.json`, through Corepack) and Docker.
