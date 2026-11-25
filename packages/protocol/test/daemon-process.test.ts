import { describe, expect, it } from 'vitest';
import pinned from '../fixtures/exit-codes.json' with { type: 'json' };
import { exitCodes } from '../src/daemon-process.ts';

// DK-2 AC3: the daemon's exit codes are written once, in `fixtures/exit-codes.json`. The daemon
// exits with `exitCodes` and the desktop app's supervisor reads them (`daemon/policy.rs`); both
// sides are pinned to that file, so a code changed on one side alone fails a test.
describe('the exit codes of the daemon (DK-2 AC3)', () => {
  it('are the ones of the shared fixture, no more and no fewer', () => {
    expect(exitCodes).toStrictEqual(pinned);
  });
});
