import type { Credential, CredentialStore } from '@earendil-works/pi-ai';

// B42: a login the daemon gets after its start (a refreshed token, a new login from Telegram, or
// one a terminal wrote to the file) is told to `remember` as soon as the store holds or reads it,
// before pi-ai sends it anywhere, so the log can hide it. B51: a refresh that fails inside
// `modify` never hands its new login to the store, yet its error may quote the new tokens (a
// token response it could not use); that error is told to `remember` before it goes on.

/** `store`, telling `remember` every login it reads, writes or keeps, and every failed change. */
export const rememberingLogins = (
  store: CredentialStore,
  remember: (kind: 'login' | 'failure', value: unknown) => void,
): CredentialStore => {
  const seen = <T extends Credential | undefined>(login: T): T => {
    if (login !== undefined) remember('login', login);
    return login;
  };
  const change =
    (fn: (current: Credential | undefined) => Promise<Credential | undefined>) =>
    async (current: Credential | undefined): Promise<Credential | undefined> => {
      try {
        return seen(await fn(current));
      } catch (error) {
        remember('failure', error);
        throw error;
      }
    };
  return {
    read: async (providerId, options) => seen(await store.read(providerId, options)),
    list: (options) => store.list(options),
    modify: async (providerId, fn, options) =>
      seen(await store.modify(providerId, change(fn), options)),
    delete: (providerId, options) => store.delete(providerId, options),
  };
};
