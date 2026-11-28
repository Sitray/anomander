import { type DoorReply, strings } from '@anomander/protocol';
import { connectionTurn, type RecentTurns } from '../conversation/recent-turns.ts';
import type { Logger } from '../processor/ports.ts';
import type { ActionRecord } from '../store/history.ts';
import {
  type ConnectionTasks,
  type DecidedCall,
  type GrantableCall,
  MAX_CONNECTION_CALLS,
  type TaskOutcome,
} from './task.ts';

// DK-11: the task with connections the chat is running, from when it is asked until it ends. The
// processor asks for calls and `ConnectionTasks` decides each one; a call that needs permission
// comes back with buttons. A task waits on servers and on the processor, so it does not hold the
// chat's turn: a step (its start, or one answered call) begins in a turn, runs outside it, and
// what it came to is said in a turn again, where its end becomes a recent turn in order with the
// others.

/** The data of the buttons under a call that waits for the principal (DK-11). */
const CONNECTION_BUTTON = 'connection:';
const CONNECTION_PRESS = /^connection:([^:]+):(allow|always|refuse)$/;
/** The longest text Telegram delivers in one message. */
const TELEGRAM_MAX_TEXT = 4096;

/** The front door a task with connections was asked at; its calls are answered there. */
export type Door = 'app' | 'telegram';
/** A reply that comes after the chat's turn: the turn does not wait for it. */
export interface Later {
  later: Promise<DoorReply | null>;
}

/** The chat's turns, one at a time (`app.ts`): what a step needs of them. */
export interface TurnLock {
  /** Runs `handler` in a turn; `ends` lets it run while the daemon stops. */
  inTurn<I, R>(
    handler: (input: I) => Promise<R>,
    options?: { ends?: boolean },
  ): (input: I) => Promise<R>;
  /** Counts `work` as running until it settles, so a stop waits for it. */
  track<T>(work: Promise<T>): Promise<T>;
}

export interface ConnectionSessionDeps {
  tasks: ConnectionTasks;
  turnLock: TurnLock;
  /** R-16 AC3: how a task ended is a recent turn. */
  turns: Pick<RecentTurns, 'add' | 'erasures'>;
  /** DK-14 AC2: keeps an action once it ended; never throws. */
  keep: (record: Omit<ActionRecord, 'endedAt'>) => void;
  /** Sends to Telegram: a task asked there is answered there, by itself. */
  send: (message: DoorReply) => Promise<void>;
  /**
   * DK-24: the principal pressed "Permitir siempre" on a call of `call`, at `door`: stores the
   * grant. Called only once the task confirmed that call waits, before it is made. Without it
   * none is offered.
   */
  grant?: (call: GrantableCall, door: Door) => void;
  logger: Logger;
}

export interface ConnectionSession {
  /**
   * Called in a turn. One task at a time: a second one is refused while a step runs. `routed`
   * when the principal asked it in words that are already a stored turn (DK-13 AC2): its end is
   * then stored with no `[conexiones]` line, so those words are stored once.
   */
  run(task: string, door: Door, routed?: boolean): DoorReply | Later | null;
  /**
   * Called in a turn: the answer to a press on "Permitir" or "Detener"; `undefined` for any
   * other button. A press at the other door, or while a step of the task runs, answers nothing.
   */
  answer(data: string, door: Door): DoorReply | Later | null | undefined;
  /** `ConnectionTasksDeps.decided`: which calls were sent or refused (DK-14 AC2). */
  decided(call: DecidedCall): void;
}

/** A task with connections, from when it is asked until it ends. */
interface Asked {
  task: string;
  door: Door;
  /** The calls code decided so far (DK-14 AC2). */
  calls: DecidedCall[];
  /** It waits for "Permitir": a task asked meanwhile ends it. */
  waiting: boolean;
  /** Asked in words already stored as a turn (`run`). */
  routed: boolean;
  /** DK-24: the call that waits, by its id, and the tool "Permitir siempre" would allow. */
  offer?: { id: string; call: GrantableCall };
}

/** How a task was cut short, and that it had made calls by then: they are not undone. */
const cutShort = (text: string, performed: number): string =>
  performed === 0 ? text : `${text} ${strings.connectionPerformed(performed)}`;

export const createConnectionSession = (deps: ConnectionSessionDeps): ConnectionSession => {
  const { tasks, turnLock, turns, keep, send, grant, logger } = deps;

  const connectionReply = (outcome: TaskOutcome, current: Asked): DoorReply => {
    switch (outcome.kind) {
      case 'answer': {
        // R-16 AC3: how the task ended is a recent turn; what the tools answered is not.
        const principal = current.routed ? null : connectionTurn(current.task);
        if (current.door === 'app') return turns.add(principal, { text: outcome.text }, 'app');
        // B55 (DK-16 AC1): in Telegram it is sent by itself after the turn, so it is stored as a
        // message sent unasked is: once delivered, as it was sent; a failed send stores nothing.
        // B81 (DK-16 AC5): an erase of the conversation after this turn, before the delivery,
        // keeps it unstored, as it would have erased it had it been stored in the turn.
        const text = outcome.text.slice(0, TELEGRAM_MAX_TEXT);
        const erasures = turns.erasures();
        return {
          text,
          onDelivered: (delivery) => {
            if (turns.erasures() !== erasures) return;
            turns.add(principal, { text }, 'telegram', delivery.channelRef);
          },
        };
      }
      case 'ask': {
        const button = (label: string, answer: string) => ({
          label,
          data: `${CONNECTION_BUTTON}${outcome.id}:${answer}`,
        });
        const always = grant !== undefined && outcome.grantable !== undefined;
        return {
          text: outcome.text,
          buttons: [
            button(strings.connectionAllow(), 'allow'),
            ...(always ? [button(strings.connectionAllowAlways(), 'always')] : []),
            button(strings.connectionRefuse(), 'refuse'),
          ],
        };
      }
      case 'stopped':
        return { text: strings.connectionStopped() };
      case 'gone':
        return { text: strings.connectionGone() };
      case 'no_connections':
        if (outcome.invalid) return { text: strings.connectionFileInvalid() };
        return {
          text:
            outcome.unreachable.length > 0
              ? strings.connectionUnreachable(outcome.unreachable)
              : strings.connectionNone(),
        };
      case 'too_many_calls':
        return { text: strings.connectionTooManyCalls(MAX_CONNECTION_CALLS) };
      case 'budget_exhausted':
        return { text: cutShort(strings.textLimitReached(), outcome.performed) };
      case 'provider_limit':
        return { text: cutShort(strings.providerLimitReached(), outcome.performed) };
      case 'failed':
        return { text: cutShort(strings.connectionFailed(), outcome.performed) };
      // DK-19: stopped from the app; the calls made are not undone.
      case 'cancelled':
        return { text: cutShort(strings.turnCancelled(), outcome.performed) };
    }
  };

  /** The last task asked, and where: a call is answered at the door that asked for the task. */
  let asked: Asked = { task: '', door: 'app', calls: [], waiting: false, routed: false };
  /** DK-14 AC2: a task that ended, as it is kept. */
  const keepTask = (task: Asked, outcome: string): void => {
    task.waiting = false;
    keep({
      kind: 'connect',
      door: task.door,
      task: task.task,
      outcome,
      steps: null,
      calls: task.calls,
    });
  };
  /** A step of that task runs: no other task starts and no press is taken until it is said. */
  let working = false;
  // It ends a step that already ran, so it is said even while the daemon stops.
  const say = turnLock.inTurn(
    async ({ outcome, task }: { outcome: TaskOutcome; task: Asked }) => {
      // A call that waits is not an end, nor is a press on one that no longer waits.
      if (outcome.kind === 'ask') {
        task.waiting = true;
        if (outcome.grantable === undefined) delete task.offer;
        else task.offer = { id: outcome.id, call: outcome.grantable };
      } else if (outcome.kind !== 'gone') keepTask(task, outcome.kind);
      return connectionReply(outcome, task);
    },
    { ends: true },
  );
  const connectionStep = (task: Asked, step: () => Promise<TaskOutcome>): Later | null => {
    const { door } = task;
    working = true;
    const reply = turnLock.track(
      step()
        .then((outcome) => say({ outcome, task }))
        .finally(() => {
          working = false;
        }),
    );
    if (door === 'app') return { later: reply };
    // Telegram hands over one update at a time, so its handler ends now and the reply goes out
    // by itself, cut to what one message holds.
    reply
      .catch((error: unknown) => {
        logger.error('The daemon failed to run a task with connections', { error });
        return { text: strings.processingFailed() };
      })
      .then((message) => send({ ...message, text: message.text.slice(0, TELEGRAM_MAX_TEXT) }))
      .catch((error: unknown) => {
        logger.error('Could not send what a task with connections came to', { error });
      });
    return null;
  };

  return {
    run: (task, door, routed = false) => {
      if (working) return { text: strings.connectionBusy() };
      // DK-11 AC8: a task that waited for "Permitir" ends here.
      if (asked.waiting) keepTask(asked, 'replaced');
      asked = { task, door, calls: [], waiting: false, routed };
      return connectionStep(asked, () => tasks.start(task));
    },
    answer: (data, door) => {
      if (!data.startsWith(CONNECTION_BUTTON)) return undefined;
      const pressed = CONNECTION_PRESS.exec(data);
      if (pressed === null || door !== asked.door || working) {
        return { text: strings.connectionGone() };
      }
      const [, id = '', answer] = pressed;
      // DK-24 AC5: only the press on "Permitir siempre" of the call that waits grants; the
      // processor never sees a button, and a press it was not offered for grants nothing.
      const task = asked;
      const { offer } = task;
      if (answer !== 'always') {
        // Any other answer to that call ends the offer: a later press on it grants nothing.
        if (offer?.id === id) delete task.offer;
        return connectionStep(task, () => tasks.answer(id, answer === 'allow'));
      }
      if (offer?.id !== id || grant === undefined) return { text: strings.connectionGone() };
      // Stored only once the task found that call waiting, before it is made. The offer ends once
      // it is stored: a grant that cannot be stored leaves the call and its offer waiting (B67).
      return connectionStep(task, () =>
        tasks.answer(id, true, () => {
          grant(offer.call, door);
          if (task.offer?.id === id) delete task.offer;
        }),
      );
    },
    decided: (call) => {
      asked.calls.push(call);
    },
  };
};
