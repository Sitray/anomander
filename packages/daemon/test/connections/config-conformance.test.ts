import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import conformance from '../../../protocol/fixtures/mcp-json-conformance.json' with {
  type: 'json',
};
import { parseConnectionsConfig } from '../../src/connections/config.ts';

// DK-11: the cases of `mcp.json` the daemon, the shell and the app's form all run
// (`packages/protocol/fixtures/mcp-json-conformance.json`), so the three cannot drift apart.

interface Difference {
  validator: string;
  list: string;
  case: string;
  valid: boolean;
}

/** Whether the daemon takes the case, unless the fixture records it disagreeing. */
const expected = (list: string, name: string, valid: boolean): boolean =>
  (conformance.expectedDifferences as Difference[]).find(
    (difference) =>
      difference.validator === 'daemon' && difference.list === list && difference.case === name,
  )?.valid ?? valid;

/** Every path the daemon logs for `document`, or `null` when it reads it. */
const refusedAt = (document: unknown): string[] | null => {
  try {
    parseConnectionsConfig(document);
    return null;
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return error.issues.map((issue) => issue.path.join('.'));
  }
};

describe('mcp.json as the daemon reads it, against the shared cases (DK-11)', () => {
  for (const entry of conformance.documents) {
    it(`${expected('documents', entry.name, entry.valid) ? 'reads' : 'refuses'} ${entry.name}`, () => {
      const at = refusedAt(entry.document);
      if (expected('documents', entry.name, entry.valid)) {
        expect(at).toBeNull();
      } else {
        expect(at).toStrictEqual(entry.daemonAt);
      }
    });
  }

  it('takes the server names the shared cases take, and only those', () => {
    for (const [names, valid] of [
      [conformance.serverNames.valid, true],
      [conformance.serverNames.invalid, false],
    ] as const) {
      for (const name of names) {
        const at = refusedAt({ mcpServers: { [name]: { command: 'x' } } });
        expect(at === null, JSON.stringify(name)).toBe(expected('serverNames', name, valid));
      }
    }
  });

  it('takes the addresses the shared cases take, and only those', () => {
    for (const [urls, valid] of [
      [conformance.urls.valid, true],
      [conformance.urls.invalid, false],
    ] as const) {
      for (const url of urls) {
        const at = refusedAt({ mcpServers: { s: { url } } });
        expect(at === null, JSON.stringify(url)).toBe(expected('urls', url, valid));
      }
    }
  });
});
