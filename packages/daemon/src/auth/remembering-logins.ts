import type { Credential, CredentialStore } from '@earendil-works/pi-ai';

// B42: a login the daemon gets after its start (a refreshed token, a new login from Telegram, or
// one a terminal wrote to the file) is told to `remember` as soon as the store holds or reads it,
// before pi-ai sends it anywhere, so the log can hide it.

/** `store`, telling `remember` every login it reads, writes or keeps. */
export const rememberingLogins = (
  store: CredentialStore,
  remember: (kind: 'login', login: Credential) => void,
): CredentialStore => {
  const seen = <T extends Credential | undefined>(login: T): T => {
    if (login !== undefined) remember('login', login);
    return login;
  };
  return {
    read: async (providerId, options) => seen(await store.read(providerId, options)),
    list: (options) => store.list(options),
    modify: async (providerId, fn, options) =>
      seen(await store.modify(providerId, async (current) => seen(await fn(current)), options)),
    delete: (providerId, options) => store.delete(providerId, options),
  };
};
