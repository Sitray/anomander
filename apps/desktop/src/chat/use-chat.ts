// DK-4: binds the chat client to React. It owns the connection for as long as the chat is on
// screen and turns what the client reports into the conversation.

import type { ComputerAction } from '@anomander/protocol';
import { useCallback, useEffect, useReducer, useRef } from 'react';
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
}

/** The shell's side of a task on the computer; both reject with the shell's own error. */
export interface Computer {
  /** A JPEG of the screen as it is now. */
  capture(): Promise<ArrayBuffer>;
  /** Performs `action` and answers with a JPEG of the screen as it left it. */
  perform(action: ComputerAction): Promise<ArrayBuffer>;
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
  task: string;
  /** The steps already performed, as the daemon described them. */
  done: string[];
  captureUrl: string;
}

/** Errors of the shell after which nothing was done: its permission checks come first. */
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
          proposed.current.set(channelRef, { ...step, action, text });
          const proposal = { action, captureUrl: step.captureUrl };
          dispatch({ type: 'outcome', requestId, outcome, proposal });
        } else {
          if (step !== undefined) URL.revokeObjectURL(step.captureUrl);
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

  /** Sends one step of `task` with the screen as `jpeg` shows it; `null` when it could not leave. */
  const step = useCallback(async (task: string, done: string[], jpeg: ArrayBuffer) => {
    const image = await encodeJpeg(jpeg);
    const requestId = client.current?.send({ type: 'computer', task, image, done }) ?? null;
    if (requestId !== null) {
      const captureUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
      asked.current.set(requestId, { task, done, captureUrl });
    }
    return requestId;
  }, []);

  const begin = useCallback(
    async (id: string, text: string) => {
      const { computer, onProblem } = latest.current;
      let requestId: string | null = null;
      try {
        if (computer !== undefined) requestId = await step(text, [], await computer.capture());
      } catch (error) {
        onProblem?.(NOTHING_DONE[String(error)] ?? strings.chat.screenFailed);
      }
      dispatch({ type: 'left', id, requestId });
    },
    [step],
  );

  const task = useCallback(
    (text: string) => {
      const id = crypto.randomUUID();
      dispatch({ type: 'said', id, text, attachments: [], task: true });
      void begin(id, text);
    },
    [begin],
  );

  const allow = useCallback(
    async (message: BotMessage) => {
      const { computer, onProblem } = latest.current;
      const proposal = proposed.current.get(message.id);
      if (computer === undefined || proposal === undefined) return;
      // Taken out first: a second press finds nothing to perform.
      proposed.current.delete(message.id);
      dispatch({ type: 'allowed', id: message.id });
      let jpeg: ArrayBuffer;
      try {
        jpeg = await computer.perform(proposal.action);
      } catch (error) {
        const nothingDone = NOTHING_DONE[String(error)];
        if (nothingDone === undefined) {
          // It may have been performed: it is never offered again.
          dispatch({ type: 'performed', id: message.id, requestId: null });
          return;
        }
        proposed.current.set(message.id, proposal);
        dispatch({ type: 'not_performed', id: message.id });
        onProblem?.(nothingDone);
        return;
      }
      let requestId: string | null = null;
      try {
        requestId = await step(proposal.task, [...proposal.done, proposal.text], jpeg);
      } catch {
        // The action was performed and the next step could not leave.
      }
      dispatch({ type: 'performed', id: message.id, requestId });
    },
    [step],
  );

  const refuse = useCallback((message: BotMessage) => {
    if (!proposed.current.delete(message.id)) return;
    dispatch({ type: 'refused', id: message.id });
  }, []);

  const retry = useCallback(
    (message: OwnMessage) => {
      dispatch({ type: 'retried', id: message.id });
      // A task goes again with the screen as it is now, never as a plain text.
      if (message.task) void begin(message.id, message.text);
      else void deliver(message.id, message.text, message.attachments);
    },
    [deliver, begin],
  );

  return { conversation, say, retry, press, task, allow, refuse };
};
