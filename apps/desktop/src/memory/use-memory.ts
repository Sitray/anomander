// DK-18: the window's "Memoria" over the local channel: what ANOMANDER remembers about the
// principal and what it did, read when its connection opens and again after each forget. It owns
// a connection of its own, so the chat's requests and this screen's never wait for each other.
import type { ChatAction, ChatMemory } from '@anomander/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ChatClient, type ConnectionState, createChatClient } from '../chat/chat-client.ts';
import type { LocalChannel } from '../shell.ts';

/** A list as the screen shows it: on its way, not read, or read. */
export type Listed<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; items: T[] };

/** What became of a forget the daemon was sent. */
export type Forgotten = 'done' | 'not_done' | 'unknown';

const LOADING = { state: 'loading' } as const;

export const useMemory = (channel: LocalChannel | null) => {
  const [connection, setConnection] = useState<ConnectionState>('offline');
  const [memories, setMemories] = useState<Listed<ChatMemory>>(LOADING);
  const [actions, setActions] = useState<Listed<ChatAction>>(LOADING);
  const client = useRef<ChatClient | null>(null);
  /** Each list's latest read: an answer to an older one is not shown over it. */
  const reads = useRef({ memories: 0, actions: 0 });

  const readMemories = useCallback((from: ChatClient | null = client.current) => {
    if (from === null) return;
    const read = ++reads.current.memories;
    setMemories(LOADING);
    void from.requestMemories().then((items) => {
      if (read !== reads.current.memories) return;
      setMemories(items === null ? { state: 'failed' } : { state: 'ready', items });
    });
  }, []);
  const readActions = useCallback((from: ChatClient | null = client.current) => {
    if (from === null) return;
    const read = ++reads.current.actions;
    setActions(LOADING);
    void from.requestActions().then((items) => {
      if (read !== reads.current.actions) return;
      setActions(items === null ? { state: 'failed' } : { state: 'ready', items });
    });
  }, []);

  useEffect(() => {
    const created = createChatClient({
      onConnection: (state) => {
        setConnection(state);
        // Read again each time it opens: something may have been forgotten through Telegram.
        if (state === 'open') {
          readMemories(created);
          readActions(created);
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
  }, [readMemories, readActions]);

  // A new snapshot with the same channel must not reconnect: depend on its values.
  const url = channel?.url ?? null;
  const token = channel?.token ?? null;
  useEffect(() => {
    client.current?.setChannel(url === null || token === null ? null : { url, token });
  }, [url, token]);

  /** Forgets one item and, once it is, reads both lists again. */
  const forget = useCallback(
    async (kind: 'memory' | 'action', id: number): Promise<Forgotten> => {
      const from = client.current;
      if (from === null) return 'not_done';
      const outcome = kind === 'memory' ? await from.forgetMemory(id) : await from.forgetAction(id);
      if (outcome === 'done') {
        readMemories(from);
        readActions(from);
      }
      return outcome;
    },
    [readMemories, readActions],
  );

  return {
    connection,
    memories,
    actions,
    forget,
    retryMemories: () => readMemories(),
    retryActions: () => readActions(),
  };
};
