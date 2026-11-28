import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasCents } from '@anomander/protocol';
import { describe, expect, it } from 'vitest';

// B74 (DK-25 AC6): the shell refuses a currency without two decimals by a list of its own
// (`WITHOUT_CENTS` in `src-tauri/src/setup.rs`), since Rust has no `Intl`. The window and the
// daemon decide it with `hasCents`, from their `Intl`; the list must say what they say, or the
// shell stores a currency the daemon refuses to start with, or refuses one the window offers.
const setup = readFileSync(resolve(import.meta.dirname, '../src-tauri/src/setup.rs'), 'utf8');

/** The codes of `WITHOUT_CENTS`, as the Rust source writes them. */
const withoutCents = (): string[] => {
  const list = /const WITHOUT_CENTS: &\[&str\] = &\[([^\]]*)\];/.exec(setup)?.[1];
  if (list === undefined) throw new Error('setup.rs no longer has WITHOUT_CENTS');
  return [...list.matchAll(/"([A-Z]{3})"/g)].map(([, code]) => code as string);
};

describe("the shell's currencies without cents", () => {
  it("are exactly the currencies this runtime's Intl writes without two decimals", () => {
    const known = Intl.supportedValuesOf('currency');
    expect(withoutCents()).toEqual(known.filter((code) => !hasCents(code)));
  });
});
