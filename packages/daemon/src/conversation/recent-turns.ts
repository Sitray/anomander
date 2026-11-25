import type { Delivery, DoorButton, Notify } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { Logger } from '../processor/ports.ts';
import {
  type ConversationMessage,
  conversationSince,
  deliveredAs,
  forgetConversation,
  recordMessages,
} from '../store/conversation.ts';

// PRD R-16 AC3: the recent turns of the conversation, so the interpreter understands "ese" or
// "lo de antes". DK-16: every turn is kept in the local database as the stored conversation, so
// the app shows it again and the turns survive a restart; the interpreter still gets only the
// latest ones. They are never logged, and are erased on "Borrar conversación", on a confirmed
// forget and after 90 days; a replaced memory takes the turns that hold its words with it
// (R-23 AC3).

export const RECENT_TURN_LIMIT = 10;
export const RECENT_TURN_MAX_AGE_MS = 30 * 60 * 1000;

/** The front door a turn went through. */
export type TurnDoor = ConversationMessage['door'];

/**
 * What the principal sent (a text, `[foto de ticket]` or `[botón: …]`) and the reply. `principal`
 * is `null` for a message sent unasked.
 */
export interface RecentTurn {
  principal: string | null;
  reply: string;
}

/** A reply as a turn keeps it: its text and its buttons, never an image or an action. */
export interface TurnReply {
  text: string;
  buttons?: readonly DoorButton[] | undefined;
  onDelivered?: ((delivery: Delivery) => void) | undefined;
}

export interface RecentTurns {
  /**
   * Stores what the principal sent at `door` and the reply, as two messages of the conversation
   * (one for a message sent unasked, with `channelRef` when it was already delivered). Returns
   * the reply to send: once delivered, its reference is kept too, so a press on one of its
   * buttons still resolves (DK-16). A failure to store it is logged and changes nothing.
   */
  add<T extends TurnReply>(
    principal: string | null,
    reply: T,
    door: TurnDoor,
    channelRef?: string,
  ): T;
  /** The last turns, oldest first, none older than 30 minutes. */
  recent(): RecentTurn[];
  /**
   * Erases the stored conversation, and so the turns. "Borrar conversación" (DK-16), and the
   * `forget_memory` and `forget_history` answers on `Sí` (R-23 AC6, DK-14 AC4) call it, so the
   * forgotten fact and the question that showed it leave the context and the database. A failure
   * to erase throws: the caller says it failed.
   */
  clear(): void;
}

export interface RecentTurnsDeps {
  db: Database.Database;
  now: () => Date;
  logger: Logger;
}

export const createRecentTurns = ({ db, now, logger }: RecentTurnsDeps): RecentTurns => ({
  add: (principal, reply, door, channelRef) => {
    const at = now().toISOString();
    const said: ConversationMessage = {
      from: 'anomander',
      door,
      text: reply.text,
      buttons: [...(reply.buttons ?? [])],
      channelRef: channelRef ?? null,
      at,
    };
    let id: number | undefined;
    try {
      id = recordMessages(
        db,
        principal === null
          ? [said]
          : [{ from: 'principal', door, text: principal, buttons: [], channelRef: null, at }, said],
      ).at(-1);
    } catch (error) {
      logger.error('conversation not saved', { reason: (error as Error).message });
    }
    if (id === undefined || channelRef !== undefined) return reply;
    const stored = id;
    return {
      ...reply,
      onDelivered: (delivery: Delivery) => {
        try {
          deliveredAs(db, stored, delivery.channelRef);
        } catch (error) {
          logger.error('conversation delivery not saved', { reason: (error as Error).message });
        }
        reply.onDelivered?.(delivery);
      },
    };
  },
  recent: () => {
    const since = new Date(now().getTime() - RECENT_TURN_MAX_AGE_MS).toISOString();
    let messages: ReturnType<typeof conversationSince>;
    try {
      messages = conversationSince(db, since);
    } catch (error) {
      // The interpreter still answers, without the context.
      logger.error('recent turns not read', { reason: (error as Error).message });
      return [];
    }
    const turns: RecentTurn[] = [];
    // A principal's message is always followed by the reply it got (`recordMessages`).
    let asked: string | null = null;
    for (const message of messages) {
      if (message.from === 'principal') asked = message.text;
      else {
        turns.push({ principal: asked, reply: message.text });
        asked = null;
      }
    }
    return turns.slice(-RECENT_TURN_LIMIT);
  },
  clear: () => {
    forgetConversation(db);
  },
});

/**
 * Records each answered input as a turn, described by `describe`, at the door `doorOf` names; no
 * reply records nothing.
 */
export const recordingTurns =
  <I, R extends TurnReply | null>(
    turns: RecentTurns,
    describe: (input: I) => string,
    handler: (input: I) => Promise<R>,
    doorOf: (input: I) => TurnDoor,
  ) =>
  async (input: I): Promise<R> => {
    const reply = await handler(input);
    return reply === null ? reply : turns.add(describe(input), reply, doorOf(input));
  };

/** DK-22: the desktop app as a door for what is sent unasked, while it is connected. */
export interface AppNotices {
  connected(): boolean;
  notify: Notify;
}

/** Why nothing was sent unasked: neither door is there. */
export const NO_DOOR = 'Telegram is not configured and the app is not connected: nothing was sent';

/**
 * Records each message sent to the principal unasked as a turn with no principal part, once it
 * was delivered. It goes to Telegram as before (R-1), when `notify` is given, and also to the
 * app while it is connected (DK-22): one fan-out, kept once, as the first door that delivered it
 * gives its reference, and `message.onDelivered` is called that once. A send that fails or ends
 * without delivering it stores nothing (DK-16 AC1); it rejects with Telegram's failure when no
 * door delivered it. When Telegram failed and the app got it, one fixed line says so, never its
 * words or the error, which may quote them.
 */
export const recordingNotices =
  (turns: RecentTurns, notify: Notify | undefined, app?: AppNotices, logger?: Logger): Notify =>
  async (message) => {
    let first: { door: TurnDoor; channelRef: string } | undefined;
    const through = (door: TurnDoor) => ({
      ...message,
      onDelivered: (delivery: Delivery) => {
        if (first !== undefined) return;
        first = { door, channelRef: delivery.channelRef };
        message.onDelivered?.(delivery);
      },
    });
    let failure: { error: unknown } | undefined;
    if (notify === undefined) failure = { error: new Error(NO_DOOR) };
    else {
      try {
        await notify(through('telegram'));
      } catch (error) {
        failure = { error };
      }
    }
    if (app?.connected() === true) {
      // An app that closed meanwhile leaves Telegram's outcome as it was.
      await app.notify(through('app')).catch(() => {});
    }
    if (first === undefined) {
      if (failure !== undefined) throw failure.error;
      return;
    }
    if (notify !== undefined && failure !== undefined) {
      logger?.warn('an unasked message reached the app but not Telegram');
    }
    turns.add(null, message, first.door, first.channelRef);
  };

/** How a task on the computer appears in the recent turns: what was asked, never the screen. */
export const computerTurn = (task: string): string => `[control del ordenador] ${task}`;

/** How a task with connections appears in the recent turns: what was asked, never a result. */
export const connectionTurn = (task: string): string => `[conexiones] ${task}`;

/** How a question about the screen appears in the recent turns: no image, only the question. */
export const screenTurn = (question: string): string => `[captura de pantalla] ${question}`;

/** How a receipt appears in the recent turns: no image, only its caption. */
export const receiptTurn = (caption: string | null): string =>
  caption === null ? '[foto de ticket]' : `[foto de ticket] ${caption}`;

/** How a button press appears in the recent turns. */
export const buttonTurn = (option: string | undefined): string =>
  option === undefined ? '[botón]' : `[botón: ${option}]`;
