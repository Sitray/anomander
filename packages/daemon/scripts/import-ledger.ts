// DK-12 (desktop next, S4): the import of a ledger brought from a Docker install, run by the
// desktop shell with the daemon stopped.
//
//   node scripts/import-ledger.ts <source> <own>
//
// Prints one word: `imported`, or why it was refused (`Refusal` in `src/store/import-ledger.ts`),
// and ends with 0. An error ends with 1 and prints only its code: a message may quote a path.
import { resolve } from 'node:path';
import { importLedger } from '../src/store/import-ledger.ts';

const [source, own] = process.argv.slice(2);
if (source === undefined || own === undefined) {
  console.error('usage: import-ledger <source> <own>');
  process.exit(2);
}
try {
  const outcome = importLedger(resolve(source), resolve(own));
  console.info(outcome.kind === 'imported' ? 'imported' : outcome.reason);
} catch (error) {
  const { code, name } = error as { code?: unknown; name?: unknown };
  console.error(`could not import the ledger: ${String(code ?? name)}`);
  process.exit(1);
}
