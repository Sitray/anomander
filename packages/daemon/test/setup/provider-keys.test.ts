import { findEnvKeys } from '@earendil-works/pi-ai/compat';
import { describe, expect, it } from 'vitest';
import { SETUP_PROVIDERS } from '../../../../apps/desktop/src/setup/providers.ts';

// B64 (DK-23 AC2): the desktop app stores a provider's key under `keyName` and hands it to the
// daemon by that name; pi-ai then reads it only if it is the variable pi-ai looks up for that
// provider. A key stored under any other name would leave the provider unconnected.
describe('the setup providers of the desktop app', () => {
  it.each(SETUP_PROVIDERS.map((provider) => [provider.id, provider.keyName] as const))(
    '%s stores its key under %s, the variable pi-ai reads for it',
    (providerId, keyName) => {
      expect(findEnvKeys(providerId, { [keyName]: 'a-key' })).toContain(keyName);
    },
  );
});
