// DK-4: binds the chat client to React. It owns the connection for as long as the chat is on
// screen and turns what the client reports into the conversation.

import { type ProgressPhase, strings as replies } from '@anomander/protocol';
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
  isReplaceable,
  type Owed,
  type OwnMessage,
  owedAnswer,
  type Route,
  reduceConversation,
} from './conversation.ts';

export type { Computer } from './computer-task-session.ts';

/**
 * DK-19: the answer owed now, and what is known of it: what the daemon said it is doing, whether
 * the principal can stop it here, and whether they already asked to.
 */
export interface Turn extends Owed {
  phase: ProgressPhase | null;
  stoppable: boolean;
  stopping: boolean;
}

/** DK-19: the turns the daemon can stop (`cancel`); a receipt or a step it cannot. */
const STOPPABLE: ReadonlySet<Owed['kind']> = new Set(['text', 'screen']);

export interface Chat {
  conversation: Conversation;
  /** DK-19: the answer owed now; `null` when none is. */
  turn: Turn | null;
  /** DK-19: asks the daemon to stop the turn owed now, when it can be stopped. */
  cancel(): void;
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
  /**
   * DK-11 AC13: adds the web search `message` offers, then asks its request again once the
   * daemon that reads it is there.
   */
  addWebSearch(message: BotMessage): void;
  /**
   * DK-16: erases the stored conversation; the window empties once the daemon is done.
   * `not_done`: nothing was erased; `unknown`: the connection was lost first.
   */
  clear(): Promise<'done' | 'not_done' | 'unknown'>;
  /**
   * B48: the window was shown again: it shows the stored conversation instead, once nothing on
   * screen would be lost.
   */
  shownAgain(): void;
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
  /**
   * DK-11 AC13: adds the web search connection; `true` when it was saved, which starts the daemon
   * again, `false` when it was already there. Absent where the window cannot add one.
   */
  addWebSearch?: () => Promise<boolean>;
}

/** DK-11 AC13: a request to ask again once the daemon that reads the new connection is there. */
interface AskAgain {
  /** The reply that offered the web search. */
  id: string;
  text: string;
  /** The channel when the press was made, and how many times the channel had gone since. */
  channel: string | null;
  gone: number;
  /**
   * Any open connection will do: nothing was saved, so no new daemon is coming; it only waits
   * for the channel to be there (B39).
   */
  anyOpen: boolean;
  /** Gives up on it once `GIVE_UP_MS` passed since the press. */
  timer: ReturnType<typeof setTimeout>;
}

/** DK-11 AC13: how long a press waits for its add and for the daemon that reads it. */
const GIVE_UP_MS = 60_000;

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
  /** The conversation as last shown, for the client's callbacks. */
  const shown = useRef(conversation);
  shown.current = conversation;
  const client = useRef<ChatClient | null>(null);
  // The latest options, so new ones do not open the connection again.
  const latest = useRef(options);
  latest.current = options;
  /** The plain texts whose answer has not arrived: only theirs may carry a route (DK-13). */
  const texts = useRef(new Set<string>());
  /** The presses whose answer has not arrived: a forget is answered to one (B48). */
  const presses = useRef(new Set<string>());
  /**
   * B48: the stored conversation is wanted instead of what is shown; it is asked for as soon as
   * nothing on screen would be lost, and wanted again when something changed before it came.
   */
  const wanted = useRef(false);
  /** A request for it is on its way. */
  const asking = useRef(false);
  const [reload, setReload] = useState(0);
  const wantStored = useCallback(() => {
    wanted.current = true;
    setReload((count) => count + 1);
  }, []);
  const [running, setRunning] = useState(false);
  /** DK-19: what the daemon said it is doing, by request. */
  const [phases, setPhases] = useState<Record<string, ProgressPhase>>({});
  /** DK-19: the requests the principal asked to stop. */
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
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
  /** The channel when the connection last opened; `null` while it is not open. */
  const opened = useRef<string | null>(null);
  /** The channel as one value, and how many times it went away: a restarted daemon is a new one. */
  const current = useRef<{ channel: string | null; gone: number }>({ channel: null, gone: 0 });
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
      onConnection: (state) => {
        // DK-11 AC13: which channel the open connection is to, so a request waits for the new one.
        opened.current = state === 'open' ? current.current.channel : null;
        dispatch({ type: 'connection', state });
        // DK-16: an empty chat shows what was said before, through either door.
        if (state === 'open' && shown.current.messages.length === 0) {
          void created.requestHistory().then((messages) => {
            if (messages !== null && messages.length > 0) dispatch({ type: 'history', messages });
          });
        }
      },
      onProgress: (requestId, phase) =>
        setPhases((known) =>
          known[requestId] === phase ? known : { ...known, [requestId]: phase },
        ),
      // DK-22: what ANOMANDER sent unasked is said in the chat and notified as an answer is.
      onNotice: (notice) => {
        dispatch({ type: 'notice', notice });
        latest.current.onReply?.(notice.text);
      },
      onOutcome: (requestId, outcome) => {
        setPhases((known) => {
          if (!(requestId in known)) return known;
          const { [requestId]: _answered, ...rest } = known;
          return rest;
        });
        setStopping((asked) => {
          if (!asked.has(requestId)) return asked;
          const rest = new Set(asked);
          rest.delete(requestId);
          return rest;
        });
        // DK-13: a route is followed only in the answer to a plain text.
        const plain = texts.current.delete(requestId);
        // B48: a forget confirmed here erased the stored conversation; the window follows it.
        const pressed = presses.current.delete(requestId);
        if (pressed && outcome.type === 'reply' && forgets(outcome.reply.text)) wantStored();
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
  }, [session, wantStored]);

  // A new snapshot with the same channel must not reconnect: depend on its values, not the object.
  const url = channel?.url ?? null;
  const token = channel?.token ?? null;
  const channelKey = url === null || token === null ? null : `${url} ${token}`;
  // Before the client hears of it: a connection that opens belongs to this channel.
  useEffect(() => {
    if (channelKey === null) current.current.gone += 1;
    current.current.channel = channelKey;
  }, [channelKey]);
  useEffect(() => {
    client.current?.setChannel(url === null || token === null ? null : { url, token });
  }, [url, token]);
  /** In the order pressed; each waits for the daemon started after its own press. */
  const askAgain = useRef<AskAgain[]>([]);
  /** Every press's give-up timer, from the press until it is over. */
  const giveUps = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [recheck, setRecheck] = useState(0);
  useEffect(
    () => () => {
      for (const timer of giveUps.current) clearTimeout(timer);
      giveUps.current.clear();
      askAgain.current = [];
    },
    [],
  );

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
      dispatch({ type: 'said', id, text, attachments, at: new Date().toISOString() });
      void deliver(id, text, attachments);
    },
    [deliver],
  );

  const press = useCallback((message: BotMessage, data: string) => {
    const requestId =
      client.current?.send({ type: 'button', data, channelRef: message.channelRef }) ?? null;
    if (requestId !== null) presses.current.add(requestId);
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

  // DK-11 AC13: a saved connection restarts the daemon; the request waits for the new one, open.
  const { connection } = conversation;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the channel changes.
  useEffect(() => {
    if (askAgain.current.length === 0 || channelKey === null || connection !== 'open') return;
    if (opened.current !== channelKey) return;
    const { channel: now, gone } = current.current;
    const back = (waiting: AskAgain) =>
      waiting.anyOpen || now !== waiting.channel || gone !== waiting.gone;
    const ready = askAgain.current.filter(back);
    askAgain.current = askAgain.current.filter((waiting) => !back(waiting));
    for (const waiting of ready) {
      clearTimeout(waiting.timer);
      giveUps.current.delete(waiting.timer);
      say(waiting.text, []);
    }
  }, [channelKey, connection, recheck, say]);

  const addWebSearch = useCallback(
    (message: BotMessage) => {
      const { offer } = message;
      const add = latest.current.addWebSearch;
      if (offer === null || add === undefined) return;
      if (offer.state === 'adding' || offer.state === 'added' || offer.state === 'already') return;
      dispatch({ type: 'offer', id: message.id, state: 'adding' });
      const before = { ...current.current };
      /** What waits for the daemon once the add answered; `null` until then. */
      let waiting: AskAgain | null = null;
      let over = false;
      // B40: the minute starts at the press, so an add that never answers gives up too. The
      // daemon may also never come back (stopped, failing): say so, and let it be pressed again.
      const timer = setTimeout(() => {
        over = true;
        giveUps.current.delete(timer);
        if (waiting === null) {
          dispatch({ type: 'offer', id: message.id, state: 'failed' });
          return;
        }
        const gaveUp = waiting;
        if (!askAgain.current.includes(gaveUp)) return;
        askAgain.current = askAgain.current.filter((other) => other !== gaveUp);
        dispatch({ type: 'offer', id: message.id, state: 'failed', why: 'not_back' });
      }, GIVE_UP_MS);
      giveUps.current.add(timer);
      const end = () => {
        over = true;
        clearTimeout(timer);
        giveUps.current.delete(timer);
      };
      void add().then(
        (saved) => {
          // Given up on already: what it says now is too late to act on.
          if (over) return;
          dispatch({ type: 'offer', id: message.id, state: saved ? 'added' : 'already' });
          // Already there: it waits for the restart an earlier press started, if one is coming;
          // otherwise it is asked again as soon as the channel is open, now if it is (B39).
          const earlier = askAgain.current.at(-1);
          const open =
            shown.current.connection === 'open' && opened.current === current.current.channel;
          if (!saved && earlier === undefined && open) {
            end();
            say(offer.ask, []);
            return;
          }
          const waitFor = saved || earlier === undefined ? { ...before, anyOpen: !saved } : earlier;
          waiting = {
            id: message.id,
            text: offer.ask,
            channel: waitFor.channel,
            gone: waitFor.gone,
            anyOpen: waitFor.anyOpen,
            timer,
          };
          askAgain.current = [...askAgain.current, waiting];
          // The daemon may be back already, and the effect above only runs on a change.
          setRecheck((count) => count + 1);
        },
        () => {
          if (over) return;
          end();
          dispatch({ type: 'offer', id: message.id, state: 'failed' });
        },
      );
    },
    [say],
  );

  // B48: the window is hidden, not closed; shown again, it shows what the daemon keeps now, so a
  // forget made through Telegram meanwhile is gone from it too. The shell says when it shows the
  // window (`shownAgain`); the page's own visibility is a second, harmless sign of it.
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') wantStored();
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [wantStored]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tried again on every change.
  useEffect(() => {
    if (!wanted.current || asking.current) return;
    // Never over something still on its way, or a task that runs or waits for "Permitir".
    if (conversation.connection !== 'open' || !isReplaceable(conversation)) return;
    if (running || askAgain.current.length > 0) return;
    const request = client.current?.requestHistory();
    if (request === undefined) return;
    wanted.current = false;
    asking.current = true;
    const replacing = conversation.messages;
    void request.then((messages) => {
      asking.current = false;
      // Not answered: tried again on the next change, such as the connection opening again.
      if (messages === null) {
        wanted.current = true;
        return;
      }
      // Something changed before it came: what is shown now may not be in it.
      if (shown.current.messages !== replacing) {
        wantStored();
        return;
      }
      dispatch({ type: 'history', messages, replacing });
    });
  }, [reload, conversation, running, recheck]);

  const owed = owedAnswer(conversation);
  const turn: Turn | null =
    owed === null
      ? null
      : {
          ...owed,
          phase: owed.requestId === null ? null : (phases[owed.requestId] ?? null),
          stoppable: owed.requestId !== null && STOPPABLE.has(owed.kind),
          stopping: owed.requestId !== null && stopping.has(owed.requestId),
        };
  const owedId = turn?.stoppable === true && !turn.stopping ? turn.requestId : null;
  const cancel = useCallback(() => {
    if (owedId === null || client.current?.cancel(owedId) !== true) return;
    setStopping((asked) => new Set(asked).add(owedId));
  }, [owedId]);

  const clear = useCallback(async () => {
    const outcome = (await client.current?.clearHistory()) ?? 'not_done';
    if (outcome === 'done') dispatch({ type: 'cleared' });
    return outcome;
  }, []);

  return {
    conversation,
    turn,
    cancel,
    say,
    retry,
    restart,
    press,
    allow,
    refuse,
    running,
    stop,
    addWebSearch,
    clear,
    shownAgain: wantStored,
  };
};

/** Whether the window can start `route` at all: it needs the shell's side of it. */
const startable = (route: Route, options: ChatOptions): boolean =>
  (route.to === 'computer' ? options.computer : options.look) !== undefined;

/** B48: the answer to a "Sí" that forgot a memory or erased the history, as the daemon says it. */
const forgets = (text: string): boolean =>
  text === replies.forgotten() || text === replies.historyForgotten();
