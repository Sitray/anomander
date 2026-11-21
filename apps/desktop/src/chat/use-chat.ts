// DK-4: binds the chat client to React. It owns the connection for as long as the chat is on
// screen and turns what the client reports into the conversation.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { LocalChannel } from '../shell.ts';
import { strings } from '../strings.ts';
import { type Attachment, encodeAttachments, encodeJpeg } from './attachments.ts';
import { type ChatClient, createChatClient, type NewRequest } from './chat-client.ts';
import { type Computer, ComputerTaskSession } from './computer-task-session.ts';
import {
  type BotMessage,
  type Conversation,
  emptyConversation,
  type OwnMessage,
  type Route,
  reduceConversation,
} from './conversation.ts';

export type { Computer } from './computer-task-session.ts';

export interface Chat {
  conversation: Conversation;
  /** Sends a text, or the attachments as one receipt with the text as caption (DK-4 AC2). */
  say(text: string, attachments: Attachment[]): void;
  /** Sends again a message that was not sent. */
  retry(message: OwnMessage): void;
  /** Starts again the look or the task `message` announced, which did not leave (DK-13). */
  restart(message: BotMessage): void;
  /** Presses a button of `message` (DK-4 AC3). */
  press(message: BotMessage, data: string): void;
  /** Performs the action `message` proposes, then asks for the next step (DK-10 AC1). */
  allow(message: BotMessage): void;
  /** Stops the task at the action `message` proposes; nothing is performed. */
  refuse(message: BotMessage): void;
  /** A task is going on by itself: a step is being planned or performed. */
  running: boolean;
  /** Stops the task that is running: nothing more is performed for it. */
  stop(): void;
}

export interface ChatOptions {
  /** Called with the text of every answer the daemon sends. */
  onReply?: (text: string) => void;
  /** Absent where the window cannot act on the computer. */
  computer?: Computer;
  /**
   * DK-9: a JPEG of the screen for a look; the app comes back after it. Absent where the window
   * cannot capture the screen. Rejects with `screen_permission` when macOS does not allow it.
   */
  look?: () => Promise<ArrayBuffer>;
  /** Called with why something on the computer could not be done. */
  onProblem?: (text: string) => void;
}

/** A task started while a look waited for its turn: the screen is the task's. */
const BUSY = Symbol('busy');

const requestFor = async (text: string, attachments: Attachment[]): Promise<NewRequest> => {
  if (attachments.length === 0) return { type: 'text', text };
  const images = await encodeAttachments(attachments);
  return { type: 'receipt', images, caption: text === '' ? null : text };
};

/** DK-13: what the window says when it cannot start `route` at all. */
const UNAVAILABLE: Record<Route['to'], string> = {
  screen: strings.chat.screenUnavailable,
  computer: strings.chat.computerUnavailable,
};

export const useChat = (channel: LocalChannel | null, options: ChatOptions = {}): Chat => {
  const [conversation, dispatch] = useReducer(reduceConversation, emptyConversation);
  const client = useRef<ChatClient | null>(null);
  // The latest options, so new ones do not open the connection again.
  const latest = useRef(options);
  latest.current = options;
  /** The plain texts whose answer has not arrived: only theirs may carry a route (DK-13). */
  const texts = useRef(new Set<string>());
  const [running, setRunning] = useState(false);
  /** The task on the computer (DK-10); it reads the options and the client as they are now. */
  const [session] = useState(
    () =>
      new ComputerTaskSession({
        dispatch,
        send: (request) => client.current?.send(request) ?? null,
        computer: () => latest.current.computer,
        onProblem: (text) => latest.current.onProblem?.(text),
        onRunning: setRunning,
        encode: encodeJpeg,
        captureUrl: (jpeg) => URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' })),
        release: (url) => URL.revokeObjectURL(url),
      }),
  );
  /** `launch`, defined below the client that calls it. */
  const launching = useRef<(id: string, route: Route) => void>(() => {});
  /** The captures of looks shown in the conversation, let go of when the chat leaves. */
  const captures = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const url of captures.current) URL.revokeObjectURL(url);
    },
    [],
  );

  useEffect(() => {
    const created = createChatClient({
      onConnection: (state) => dispatch({ type: 'connection', state }),
      onOutcome: (requestId, outcome) => {
        // DK-13: a route is followed only in the answer to a plain text.
        const plain = texts.current.delete(requestId);
        const step = session.answer(requestId, outcome);
        // A step on the way to the next one is not an answer to notify.
        if (step === 'routine') return;
        if (step === null) {
          const route = plain && outcome.type === 'reply' ? outcome.reply.route : undefined;
          const able = route !== undefined && startable(route, latest.current);
          dispatch({ type: 'outcome', requestId, outcome, ...(able ? { start: route } : {}) });
          if (route !== undefined && outcome.type === 'reply') {
            if (able) launching.current(outcome.reply.channelRef, route);
            else latest.current.onProblem?.(UNAVAILABLE[route.to]);
          }
        }
        if (outcome.type === 'reply') latest.current.onReply?.(outcome.reply.text);
      },
    });
    client.current = created;
    return () => {
      created.dispose();
      client.current = null;
    };
  }, [session]);

  // A new snapshot with the same channel must not reconnect: depend on its values, not the object.
  const url = channel?.url ?? null;
  const token = channel?.token ?? null;
  useEffect(() => {
    client.current?.setChannel(url === null || token === null ? null : { url, token });
  }, [url, token]);

  const deliver = useCallback(async (id: string, text: string, attachments: Attachment[]) => {
    let requestId: string | null = null;
    try {
      const request = await requestFor(text, attachments);
      requestId = client.current?.send(request) ?? null;
      if (requestId !== null && request.type === 'text') texts.current.add(requestId);
    } catch {
      // A file that cannot be read never left: it is reported as not sent.
    }
    dispatch({ type: 'left', id, requestId });
  }, []);

  const say = useCallback(
    (text: string, attachments: Attachment[]) => {
      const id = crypto.randomUUID();
      dispatch({ type: 'said', id, text, attachments });
      void deliver(id, text, attachments);
    },
    [deliver],
  );

  const press = useCallback((message: BotMessage, data: string) => {
    const requestId =
      client.current?.send({ type: 'button', data, channelRef: message.channelRef }) ?? null;
    dispatch({ type: 'pressed', id: message.id, data, requestId });
  }, []);

  /**
   * Takes the look the reply `id` announced (DK-9): a capture once every action asked before it
   * is over, shown in the conversation and sent with `question`.
   */
  const glance = useCallback(
    async (id: string, question: string) => {
      const { look, onProblem } = latest.current;
      // `launch` asked `startable` first: this only narrows the type, and never leaves it pending.
      if (look === undefined) {
        dispatch({ type: 'started', id, requestId: null });
        return;
      }
      let jpeg: ArrayBuffer | null = null;
      try {
        // A task owns the screen while it goes: a look would bring the app back in its way.
        jpeg = await session.inTurn(() => {
          if (session.running) throw BUSY;
          return look();
        });
      } catch (error) {
        if (error === BUSY) onProblem?.(strings.chat.computerBusy);
        else if (error === 'screen_permission') onProblem?.(strings.chat.screenPermission);
        else onProblem?.(strings.chat.screenFailed);
      }
      if (jpeg === null) {
        dispatch({ type: 'started', id, requestId: null });
        return;
      }
      let requestId: string | null = null;
      try {
        const image = await encodeJpeg(jpeg);
        requestId = client.current?.send({ type: 'screen', text: question, image }) ?? null;
      } catch {
        // A capture that cannot be read never left: it is reported as not sent.
      }
      const captureUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
      captures.current.add(captureUrl);
      dispatch({ type: 'started', id, requestId, captureUrl });
    },
    [session],
  );

  /** Starts the look or the task the reply `id` announced, or says why it cannot. */
  const launch = useCallback(
    (id: string, route: Route) => {
      if (!startable(route, latest.current)) {
        latest.current.onProblem?.(UNAVAILABLE[route.to]);
        dispatch({ type: 'started', id, requestId: null });
      } else if (route.to === 'computer') void session.begin(id, route.task);
      else void glance(id, route.task);
    },
    [session, glance],
  );
  launching.current = launch;

  const restart = useCallback(
    (message: BotMessage) => {
      const { start } = message;
      if (start === null || start.delivery !== 'not_sent') return;
      if (start.captureUrl !== null) {
        URL.revokeObjectURL(start.captureUrl);
        captures.current.delete(start.captureUrl);
      }
      dispatch({ type: 'restarted', id: message.id });
      launch(message.id, start.route);
    },
    [launch],
  );

  const allow = useCallback((message: BotMessage) => void session.allow(message.id), [session]);

  const refuse = useCallback((message: BotMessage) => session.refuse(message.id), [session]);

  const stop = useCallback(() => session.stop(), [session]);

  const retry = useCallback(
    (message: OwnMessage) => {
      dispatch({ type: 'retried', id: message.id });
      void deliver(message.id, message.text, message.attachments);
    },
    [deliver],
  );

  return { conversation, say, retry, restart, press, allow, refuse, running, stop };
};

/** Whether the window can start `route` at all: it needs the shell's side of it. */
const startable = (route: Route, options: ChatOptions): boolean =>
  (route.to === 'computer' ? options.computer : options.look) !== undefined;
