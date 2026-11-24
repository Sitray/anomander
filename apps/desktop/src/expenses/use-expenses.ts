// DK-17: what the "Gastos" screen shows, asked of the daemon over its own connection to the local
// channel. It only reads, so a request lost with its connection is asked again once it reopens.
import type { ChatExpenses } from '@anomander/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ChatClient, type ConnectionState, createChatClient } from '../chat/chat-client.ts';
import type { LocalChannel } from '../shell.ts';

export type ExpensesState =
  /** There is no channel: the daemon is not running. */
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'shown'; answer: ChatExpenses };

export interface Expenses {
  state: ExpensesState;
  /** `YYYY-MM` on screen or being asked for; `null` until the daemon said which is current. */
  month: string | null;
  /** The daemon's current month, the last one that can be shown. */
  current: string | null;
  show: (month: string) => void;
  retry: () => void;
}

/** `2026-01` and `-1` → `2025-12`. */
export const shiftMonth = (month: string, by: number): string => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, number - 1 + by, 1));
  return shifted.toISOString().slice(0, 7);
};

export function useExpenses(channel: LocalChannel | null): Expenses {
  const client = useRef<ChatClient | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('offline');
  /** `null` asks for the daemon's current month. */
  const [asked, setAsked] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<ChatExpenses | 'failed' | null>(null);

  useEffect(() => {
    const created = createChatClient({ onConnection: setConnection, onOutcome: () => {} });
    client.current = created;
    return () => {
      created.dispose();
      client.current = null;
    };
  }, []);

  // A new snapshot with the same channel must not reconnect: depend on its values, not the object.
  const url = channel?.url ?? null;
  const token = channel?.token ?? null;
  useEffect(() => {
    client.current?.setChannel(url === null || token === null ? null : { url, token });
  }, [url, token]);

  useEffect(() => {
    // `attempt` only asks again.
    void attempt;
    if (connection !== 'open') return;
    let gone = false;
    setOutcome(null);
    void client.current?.requestExpenses(asked ?? undefined).then((answer) => {
      // Lost: the connection reopens and this asks again.
      if (gone || answer === 'lost') return;
      if (answer !== 'failed' && asked === null) setCurrent(answer.month);
      setOutcome(answer);
    });
    return () => {
      gone = true;
    };
  }, [connection, asked, attempt]);

  const state: ExpensesState =
    channel === null
      ? { kind: 'closed' }
      : outcome === null
        ? { kind: 'loading' }
        : outcome === 'failed'
          ? { kind: 'failed' }
          : { kind: 'shown', answer: outcome };
  const month = asked ?? (typeof outcome === 'object' && outcome !== null ? outcome.month : null);

  const show = useCallback((next: string) => setAsked(next), []);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { state, month, current, show, retry };
}
