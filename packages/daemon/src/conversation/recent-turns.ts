import type { Notify, Reply } from '@anomander/protocol';

// PRD R-16 AC3: the recent turns of the conversation, so the interpreter understands "ese" or
// "lo de antes". They live only in this process: never written to the database or logged, and
// lost on restart, because open conversation persists nothing but the memories of R-23.

export const RECENT_TURN_LIMIT = 10;
export const RECENT_TURN_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * What the principal sent (a text, `[foto de ticket]` or `[botón: …]`) and the reply. `principal`
 * is `null` for a message sent unasked.
 */
export interface RecentTurn {
  principal: string | null;
  reply: string;
}

export interface RecentTurns {
  add(principal: string | null, reply: string): void;
  /** The last turns, oldest first, none older than 30 minutes. */
  recent(): RecentTurn[];
  /** Empties the turns: a confirmed forget (R-23 AC6) calls it, so the fact leaves the context. */
  clear(): void;
}

export const createRecentTurns = ({ now }: { now: () => Date }): RecentTurns => {
  let turns: (RecentTurn & { at: number })[] = [];
  const fresh = () => {
    const oldest = now().getTime() - RECENT_TURN_MAX_AGE_MS;
    turns = turns.filter(({ at }) => at >= oldest).slice(-RECENT_TURN_LIMIT);
    return turns;
  };
  return {
    add: (principal, reply) => {
      turns.push({ principal, reply, at: now().getTime() });
      fresh();
    },
    recent: () => fresh().map(({ principal, reply }) => ({ principal, reply })),
    clear: () => {
      turns = [];
    },
  };
};

/** Records each answered input as a turn, described by `describe`; no reply records nothing. */
export const recordingTurns =
  <I, R extends Reply | null>(
    turns: RecentTurns,
    describe: (input: I) => string,
    handler: (input: I) => Promise<R>,
  ) =>
  async (input: I): Promise<R> => {
    const reply = await handler(input);
    if (reply !== null) turns.add(describe(input), reply.text);
    return reply;
  };

/** Records each message sent to the principal unasked as a turn with no principal part. */
export const recordingNotices =
  (turns: RecentTurns, notify: Notify): Notify =>
  async (message) => {
    await notify(message);
    turns.add(null, message.text);
  };

/** How a receipt appears in the recent turns: no image, only its caption. */
export const receiptTurn = (caption: string | null): string =>
  caption === null ? '[foto de ticket]' : `[foto de ticket] ${caption}`;

/** How a button press appears in the recent turns. */
export const buttonTurn = (option: string | undefined): string =>
  option === undefined ? '[botón]' : `[botón: ${option}]`;
