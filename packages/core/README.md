# @anomander/core

The ontology, truth and authority rules of ANOMANDER (PRD §6–§8), as pure functions. Nothing
here reads a clock, a database or a network; callers pass `now`, `today` and the rows they
loaded. The daemon is the only package that persists what these functions decide.

| Module | What it decides | PRD |
| --- | --- | --- |
| `ontology.ts` | The vocabulary (modes, actors, statuses) and `assertionDraftSchema`, which every assertion passes before it is stored | §6, §7.2 |
| `processor-output.ts` | `validateProcessorOutput`: a processor may only infer; anything claiming another mode is rejected | R-14 AC2 |
| `consistency.ts` | `checkConsistency` (lines sum to the total, valid date, duplicates), `corroborate`, `todayIn`, `isCalendarDate` | R-4 |
| `categorization.ts` | `categorize`: declared, then policy, then an existing inferred category, else none | R-5 |
| `authority.ts` | `checkAuthority`: free, with permission, with confirmation or forbidden | §8.1, R-6 |
| `amounts.ts` | `literalAmountsInCents`, `isLiteralAmount`: the amounts a message writes in the forms `23`, `23,40`, `23.40`, `23€`, `23 €`, `€23` | R-2 AC5, AC6 |

## Rules for contributors

- `packages/core` imports only its own files and `zod`. `test/boundary.test.ts` fails on any
  other import (R-15 AC2), including the daemon, an app or a provider SDK.
- Keep functions pure and deterministic: the authority check is code, never a model step, and
  confidence is never an input to it (§8.1).
- Field names mirror the columns of PRD §13, so the daemon can store these shapes directly.

## Tests

```sh
pnpm vitest run packages/core
pnpm -F @anomander/core typecheck
```

Unit tests pin one PRD rule each; property tests (fast-check) cover rules that must hold for any
input, such as "the lines check accepts if and only if the lines sum to the total".
