// Security audit M4: a caller that keeps sending a wrong token is made to wait. Each remote
// address may fail this many times in a window; then every request it sends, even with the right
// token, gets `429` until the window that began with its first failure has passed.

/** Wrong tokens an address may send in one window. */
export const AUTH_FAILURES_ALLOWED = 10;
/** The window, from an address's first failure. */
export const AUTH_FAILURE_WINDOW_MS = 60_000;
/** Addresses remembered at most, so a flood of them cannot grow memory without bound. */
export const AUTH_ADDRESSES_KEPT = 1024;

interface Failures {
  count: number;
  /** When the first failure of this window happened. */
  since: number;
}

export interface AuthBackoff {
  /** Seconds the address must wait before it is answered again; `0` when it need not. */
  waitFor(address: string): number;
  /** A wrong token from `address`. Returns `true` when it has just used up its window. */
  failed(address: string): boolean;
  /** The right token from `address`: its failures are forgotten. */
  succeeded(address: string): void;
}

export const createAuthBackoff = (now: () => number): AuthBackoff => {
  const failures = new Map<string, Failures>();
  const current = (address: string): Failures | undefined => {
    const entry = failures.get(address);
    if (entry === undefined || now() - entry.since < AUTH_FAILURE_WINDOW_MS) return entry;
    failures.delete(address);
    return undefined;
  };
  /** Makes room for one more address: the windows that ended go first, then the oldest one. */
  const makeRoom = (): void => {
    if (failures.size < AUTH_ADDRESSES_KEPT) return;
    for (const [address, entry] of failures) {
      if (now() - entry.since >= AUTH_FAILURE_WINDOW_MS) failures.delete(address);
    }
    const oldest = failures.keys().next();
    if (failures.size >= AUTH_ADDRESSES_KEPT && oldest.done !== true) failures.delete(oldest.value);
  };

  return {
    waitFor: (address) => {
      const entry = current(address);
      if (entry === undefined || entry.count < AUTH_FAILURES_ALLOWED) return 0;
      return Math.ceil((entry.since + AUTH_FAILURE_WINDOW_MS - now()) / 1000);
    },
    failed: (address) => {
      let entry = current(address);
      if (entry === undefined) {
        makeRoom();
        entry = { count: 0, since: now() };
        failures.set(address, entry);
      }
      entry.count += 1;
      return entry.count === AUTH_FAILURES_ALLOWED;
    },
    succeeded: (address) => {
      failures.delete(address);
    },
  };
};
