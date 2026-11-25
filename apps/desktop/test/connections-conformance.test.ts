import { describe, expect, it } from 'vitest';
import conformance from '../../../packages/protocol/fixtures/mcp-json-conformance.json' with {
  type: 'json',
};
import { isServerName, isServerUrl } from '../src/connections/validation.ts';

// DK-11: the form checks a server's name and address before saving, as the shell and the daemon
// read them; the three run the same cases (`packages/protocol/fixtures/mcp-json-conformance.json`).
// The form never reads a whole file, so it runs the names and the addresses alone.

interface Difference {
  validator: string;
  list: string;
  case: string;
  valid: boolean;
}

/** Whether the form takes the case, unless the fixture records it disagreeing. */
const expected = (list: string, value: string, valid: boolean): boolean =>
  (conformance.expectedDifferences as Difference[]).find(
    (difference) =>
      difference.validator === 'app' && difference.list === list && difference.case === value,
  )?.valid ?? valid;

describe('the connection form, against the shared cases of mcp.json (DK-11)', () => {
  it('takes the server names the shared cases take, and only those', () => {
    for (const [names, valid] of [
      [conformance.serverNames.valid, true],
      [conformance.serverNames.invalid, false],
    ] as const) {
      for (const name of names) {
        expect(isServerName(name), JSON.stringify(name)).toBe(expected('serverNames', name, valid));
      }
    }
  });

  it('takes the addresses the shared cases take, and only those', () => {
    for (const [urls, valid] of [
      [conformance.urls.valid, true],
      [conformance.urls.invalid, false],
    ] as const) {
      for (const url of urls) {
        expect(isServerUrl(url), JSON.stringify(url)).toBe(expected('urls', url, valid));
      }
    }
  });
});
