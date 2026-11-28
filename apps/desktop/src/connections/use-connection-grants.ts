// DK-24 AC3: the tools the principal allowed with "Permitir siempre", as the daemon keeps them,
// read when its connection opens and again after each "Quitar". It owns a connection of its own,
// as "Memoria" does, so the chat's requests and this screen's never wait for each other.
import type { ChatConnectionGrant } from '@anomander/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ChatClient, createChatClient } from '../chat/chat-client.ts';
import type { LocalChannel } from '../shell.ts';

/** What the screen says about the grants: not read yet, not read, or read. */
export type Grants =
  | { state: 'none' }
  | { state: 'failed' }
  | { state: 'ready'; items: ChatConnectionGrant[] };

/** What became of a "Quitar" that did not end in `done`. */
export type RevokeProblem = 'not_done' | 'unknown';

const NONE = { state: 'none' } as const;

export const useConnectionGrants = (channel: LocalChannel | null | undefined) => {
  const [grants, setGrants] = useState<Grants>(NONE);
  const [revoking, setRevoking] = useState(false);
  const [problem, setProblem] = useState<RevokeProblem | null>(null);
  const client = useRef<ChatClient | null>(null);
  /** The latest read: an answer to an older one is not shown over it. */
  const reads = useRef(0);

  const read = useCallback((from: ChatClient | null = client.current) => {
    if (from === null) return;
    const current = ++reads.current;
    void from.requestConnectionGrants().then((items) => {
      if (current !== reads.current) return;
      setGrants(items === null ? { state: 'failed' } : { state: 'ready', items });
    });
  }, []);

  useEffect(() => {
    const created = createChatClient({
      onConnection: (state) => {
        // Read again each time it opens: one may have been granted in the meantime.
        if (state === 'open') read(created);
        else {
          // B67: a read the connection lost answers after this; it is not shown over "none".
          reads.current += 1;
          setGrants(NONE);
        }
      },
      // It sends nothing but its own requests, which never settle as outcomes.
      onOutcome: () => {},
    });
    client.current = created;
    return () => {
      created.dispose();
      client.current = null;
    };
  }, [read]);

  // A new snapshot with the same channel must not reconnect: depend on its values.
  const url = channel?.url ?? null;
  const token = channel?.token ?? null;
  useEffect(() => {
    client.current?.setChannel(url === null || token === null ? null : { url, token });
  }, [url, token]);

  /** "Quitar" on one grant and, once it is revoked, the list again. */
  const revoke = useCallback(
    async (grantId: number) => {
      const from = client.current;
      if (from === null) return;
      setProblem(null);
      setRevoking(true);
      const outcome = await from.revokeConnectionGrant(grantId);
      setRevoking(false);
      if (outcome === 'done') read(from);
      else setProblem(outcome);
    },
    [read],
  );

  return { grants, revoking, problem, revoke };
};
