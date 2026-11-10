// DK-4: binds the chat client to React. It owns the connection for as long as the chat is on
// screen and turns what the client reports into the conversation.

import type { ComputerAction } from '@anomander/protocol';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { LocalChannel } from '../shell.ts';
import { strings } from '../strings.ts';
import { type Attachment, encodeAttachments, encodeJpeg } from './attachments.ts';
import { type ChatClient, createChatClient, type NewRequest } from './chat-client.ts';
import {
  type BotMessage,
  type Conversation,
  emptyConversation,
  type OwnMessage,
  reduceConversation,
} from './conversation.ts';

export interface Chat {
  conversation: Conversation;
  /** Sends a text, or the attachments as one receipt with the text as caption (DK-4 AC2). */
  say(text: string, attachments: Attachment[]): void;
  /** Sends again a message that was not sent. */
  retry(message: OwnMessage): void;
  /** Presses a button of `message` (DK-4 AC3). */
  press(message: BotMessage, data: string): void;
  /** Starts a task on the computer (DK-10): sends it with the screen as it is now. */
  task(text: string): void;
  /** Performs the action `message` proposes, then asks for the next step (DK-10 AC1). */
  allow(message: BotMessage): void;
  /** Stops the task at the action `message` proposes; nothing is performed. */
  refuse(message: BotMessage): void;
  /** A task is going on by itself: a step is being planned or performed. */
  running: boolean;
  /** Stops the task that is running: nothing more is performed for it. */
  stop(): void;
  /** Runs `work` on the screen once every capture and action asked before it is over. */
  afterComputer<T>(work: () => Promise<T>): Promise<T>;
}

/** The shell's side of a task on the computer; both reject with the shell's own error. */
export interface Computer {
  /** A JPEG of the screen as it is now; the app stays out of the way after it. */
  capture(): Promise<ArrayBuffer>;
  /**
   * Performs `action` and answers with a JPEG of the screen as it left it; the app stays out of
   * the way after it.
   */
  perform(action: ComputerAction): Promise<ArrayBuffer>;
  /** Brings the app back: the task waits for the principal, or is over. */
  reveal(): void;
}

export interface ChatOptions {
  /** Called with the text of every answer the daemon sends. */
  onReply?: (text: string) => void;
  /** Absent where the window cannot act on the computer. */
  computer?: Computer;
  /** Called with why something on the computer could not be done. */
  onProblem?: (text: string) => void;
}

/** A step of a task that is waiting for its answer, or for the principal. */
interface Step {
  /** The task it belongs to: only the latest one may act (see `run`). */
  run: number;
  task: string;
  /** The steps already performed, as the daemon described them. */
  done: string[];
  captureUrl: string;
}

/** Errors of the shell after which nothing was done: its permission checks come first. */
/** The task ended while its action waited for its turn: it was not performed. */
const ENDED = Symbol('ended');

const NOTHING_DONE: Record<string, string> = {
  computer_permission: strings.chat.computerPermission,
  screen_permission: strings.chat.screenPermission,
};

const requestFor = async (text: string, attachments: Attachment[]): Promise<NewRequest> => {
  if (attachments.length === 0) return { type: 'text', text };
  const images = await encodeAttachments(attachments);
  const [capture] = images;
  // A capture travels alone, as a question about the screen.
  if (attachments.some((attachment) => attachment.screen) && capture !== undefined) {
    return { type: 'screen', text, image: capture };
  }
  return { type: 'receipt', images, caption: text === '' ? null : text };
};

export const useChat = (channel: LocalChannel | null, options: ChatOptions = {}): Chat => {
  const [conversation, dispatch] = useReducer(reduceConversation, emptyConversation);
  const client = useRef<ChatClient | null>(null);
  // The latest options, so new ones do not open the connection again.
  const latest = useRef(options);
  latest.current = options;
  /** The steps whose answer has not arrived, by request. */
  const asked = useRef(new Map<string, Step>());
  /** The proposals the principal has not answered, by the reply that carries them. */
  const proposed = useRef(new Map<string, Step & { action: ComputerAction; text: string }>());
  const [running, show] = useState(false);
  /** `running` as it is now, for what is decided between two renders. */
  const going = useRef(false);
  const setRunning = useCallback((next: boolean) => {
    going.current = next;
    show(next);
  }, []);
  /**
   * One task at a time: starting a task or stopping one moves this on, and whatever belongs to
   * an earlier number is over. Its answers are shown, and nothing more is performed for it.
   */
  const run = useRef(0);
  /** What the shell is doing on the computer: one capture or action at a time, in order. */
  const turns = useRef<Promise<unknown>>(Promise.resolve());
  const busy = useRef(0);
  /** `perform`, which is defined below the client that calls it. */
  const performing = useRef<(id: string) => void>(() => {});
  /** `rest`, defined below as well. */
  const rest = useRef<() => void>(() => {});

  useEffect(() => {
    const created = createChatClient({
      onConnection: (state) => dispatch({ type: 'connection', state }),
      onOutcome: (requestId, outcome) => {
        // DK-10: an action is offered only in answer to a step the principal asked for.
        const step = asked.current.get(requestId);
        asked.current.delete(requestId);
        const action = outcome.type === 'reply' ? outcome.reply.computer : undefined;
        if (step !== undefined && outcome.type === 'reply' && action !== undefined) {
          const { channelRef, text } = outcome.reply;
          const ended = step.run !== run.current;
          // DK-10 AC1: only a step the daemon calls routine goes without asking.
          const routine = outcome.reply.confirm === false && !ended;
          const proposal = { action, captureUrl: step.captureUrl, confirm: !routine };
          dispatch({ type: 'outcome', requestId, outcome, proposal });
          if (ended) {
            dispatch({ type: 'refused', id: channelRef });
          } else {
            proposed.current.set(channelRef, { ...step, action, text });
            if (routine) {
              performing.current(channelRef);
              // A step on the way to the next one is not an answer to notify.
              return;
            }
            rest.current();
          }
        } else {
          if (step !== undefined) {
            URL.revokeObjectURL(step.captureUrl);
            if (step.run === run.current) rest.current();
          }
          dispatch({ type: 'outcome', requestId, outcome });
        }
        if (outcome.type === 'reply') latest.current.onReply?.(outcome.reply.text);
      },
    });
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

  const deliver = useCallback(async (id: string, text: string, attachments: Attachment[]) => {
    let requestId: string | null = null;
    try {
      requestId = client.current?.send(await requestFor(text, attachments)) ?? null;
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

  /** Runs `work` on the computer once everything asked before it is over. */
  const inTurn = useCallback(<T>(work: () => Promise<T>): Promise<T> => {
    busy.current += 1;
    const turn = turns.current.then(work);
    turns.current = turn.then(
      () => {},
      () => {},
    );
    void turns.current.then(() => {
      busy.current -= 1;
    });
    return turn;
  }, []);

  /** The task no longer goes by itself: the app comes back, after any action still going. */
  rest.current = () => {
    setRunning(false);
    const reveal = () => latest.current.computer?.reveal();
    if (busy.current === 0) reveal();
    // By its turn another task may be going: then the app stays out of the way.
    else
      void inTurn(async () => {
        if (!going.current) reveal();
      });
  };

  /** Ends whatever task there is: its steps that waited for the principal are answered. */
  const abandon = useCallback(() => {
    run.current += 1;
    for (const id of proposed.current.keys()) dispatch({ type: 'refused', id });
    proposed.current.clear();
  }, []);

  /** Sends one step of `task` with the screen as `jpeg` shows it; `null` when it could not leave. */
  const step = useCallback(async (of: number, task: string, done: string[], jpeg: ArrayBuffer) => {
    const image = await encodeJpeg(jpeg);
    // The task ended while the screen was read: its step does not leave.
    if (of !== run.current) return null;
    const requestId = client.current?.send({ type: 'computer', task, image, done }) ?? null;
    if (requestId !== null) {
      const captureUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
      asked.current.set(requestId, { run: of, task, done, captureUrl });
    }
    return requestId;
  }, []);

  const begin = useCallback(
    async (id: string, text: string) => {
      const { computer, onProblem } = latest.current;
      // One task at a time: this one ends the one before.
      abandon();
      const mine = run.current;
      let requestId: string | null = null;
      setRunning(computer !== undefined);
      try {
        if (computer !== undefined) {
          const jpeg = await inTurn(() => {
            if (mine !== run.current) throw ENDED;
            return computer.capture();
          });
          requestId = await step(mine, text, [], jpeg);
        }
      } catch (error) {
        if (error !== ENDED && mine === run.current) {
          onProblem?.(NOTHING_DONE[String(error)] ?? strings.chat.screenFailed);
        }
      }
      if (requestId === null && mine === run.current) rest.current();
      dispatch({ type: 'left', id, requestId });
    },
    [step, abandon, inTurn],
  );

  const task = useCallback(
    (text: string) => {
      const id = crypto.randomUUID();
      dispatch({ type: 'said', id, text, attachments: [], task: true });
      void begin(id, text);
    },
    [begin],
  );

  /** Performs the proposal of the reply `id`, once, then asks for the next step. */
  const perform = useCallback(
    async (id: string) => {
      const { computer, onProblem } = latest.current;
      const proposal = proposed.current.get(id);
      if (computer === undefined || proposal === undefined) return;
      // Taken out first: a second press finds nothing to perform.
      proposed.current.delete(id);
      const mine = proposal.run;
      setRunning(true);
      dispatch({ type: 'allowed', id });
      let jpeg: ArrayBuffer;
      try {
        jpeg = await inTurn(() => {
          if (mine !== run.current) throw ENDED;
          return computer.perform(proposal.action);
        });
      } catch (error) {
        if (error === ENDED) {
          dispatch({ type: 'refused', id });
          return;
        }
        const current = mine === run.current;
        if (current) rest.current();
        const nothingDone = NOTHING_DONE[String(error)];
        if (nothingDone === undefined) {
          // It may have been performed: it is never offered again.
          dispatch({ type: 'performed', id, requestId: null });
          return;
        }
        if (current) {
          proposed.current.set(id, proposal);
          dispatch({ type: 'not_performed', id });
          onProblem?.(nothingDone);
        } else {
          dispatch({ type: 'refused', id });
        }
        return;
      }
      if (mine !== run.current) {
        // Performed, and the task ended meanwhile: no next step is asked for.
        dispatch({ type: 'performed_last', id });
        return;
      }
      let requestId: string | null = null;
      try {
        requestId = await step(mine, proposal.task, [...proposal.done, proposal.text], jpeg);
      } catch {
        // The action was performed and the next step could not leave.
      }
      if (mine !== run.current) {
        dispatch({ type: 'performed_last', id });
        return;
      }
      if (requestId === null) rest.current();
      dispatch({ type: 'performed', id, requestId });
    },
    [step, inTurn],
  );
  performing.current = (id) => void perform(id);

  const allow = useCallback((message: BotMessage) => void perform(message.id), [perform]);

  const refuse = useCallback((message: BotMessage) => {
    if (!proposed.current.delete(message.id)) return;
    dispatch({ type: 'refused', id: message.id });
  }, []);

  const stop = useCallback(() => {
    abandon();
    rest.current();
  }, [abandon]);

  const retry = useCallback(
    (message: OwnMessage) => {
      dispatch({ type: 'retried', id: message.id });
      // A task goes again with the screen as it is now, never as a plain text.
      if (message.task) void begin(message.id, message.text);
      else void deliver(message.id, message.text, message.attachments);
    },
    [deliver, begin],
  );

  return {
    conversation,
    say,
    retry,
    press,
    task,
    allow,
    refuse,
    running,
    stop,
    afterComputer: inTurn,
  };
};
