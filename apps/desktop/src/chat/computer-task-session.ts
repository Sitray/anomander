// DK-10: a task on the computer, one step at a time, without React. The chat hook hands it the
// conversation, the socket and the shell; it decides which step goes, which waits for the
// principal, and when the task is over.

import {
  type ChatImage,
  type ComputerAction,
  perLocale,
  strings as said,
} from '@anomander/protocol';
import { strings } from '../strings.ts';
import type { NewRequest, Outcome } from './chat-client.ts';
import type { ConversationAction } from './conversation.ts';

/** The shell's side of a task on the computer; both reject with the shell's own error. */
export interface Computer {
  /** A JPEG of the screen as it is now; the app stays out of the way after it. */
  capture(): Promise<ArrayBuffer>;
  /**
   * Performs `action` and answers with a JPEG of the screen as it left it; the app stays out of
   * the way after it. `permitted` when the principal allowed it: without it the shell judges the
   * screen itself and may answer `computer_careful` (T1b).
   */
  perform(action: ComputerAction, permitted: boolean): Promise<ArrayBuffer>;
  /** Brings the app back: the task waits for the principal, or is over. */
  reveal(): void;
}

/** What a session works with; each is read when it is used, never kept. */
export interface ComputerTaskDeps {
  /** Tells the conversation what became of a step. */
  dispatch(action: ConversationAction): void;
  /** Sends `request` to the daemon and returns its id, or `null` when nothing was sent. */
  send(request: NewRequest): string | null;
  /** The shell's side as it is now; absent where the window cannot act on the computer. */
  computer(): Computer | undefined;
  /** Called with why something on the computer could not be done. */
  onProblem(text: string): void;
  /** Called whenever `running` is set. */
  onRunning(running: boolean): void;
  /** A capture as a request carries it. */
  encode(jpeg: ArrayBuffer): Promise<ChatImage>;
  /** A capture as the conversation shows it, and its release. */
  captureUrl(jpeg: ArrayBuffer): string;
  release(url: string): void;
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

/** The task ended while its action waited for its turn: it was not performed. */
const ENDED = Symbol('ended');

/** Errors of the shell after which nothing was done: its permission checks come first. */
const NOTHING_DONE: Record<string, string> = {
  get computer_permission() {
    return strings.chat.computerPermission;
  },
  get screen_permission() {
    return strings.chat.screenPermission;
  },
};

/**
 * T1b: the shell saw a step of care nobody allowed; nothing was done, and it is asked for. It
 * may say what it read there: `computer_careful:<role>:<name>`.
 */
const CAREFUL = 'computer_careful';

/** What an Accessibility role is, in the principal's words, and what any other one is. */
const NOUNS = perLocale<{ roles: Record<string, string>; other: string }>({
  es: {
    roles: {
      AXButton: 'botón',
      AXMenuButton: 'botón',
      AXPopUpButton: 'botón',
      AXLink: 'enlace',
      AXMenuItem: 'opción de menú',
      AXMenuBarItem: 'opción de menú',
      AXCheckBox: 'casilla',
      AXRadioButton: 'opción',
      AXTextField: 'campo',
      AXTextArea: 'campo',
      AXComboBox: 'campo',
      AXWebArea: 'página',
    },
    other: 'elemento',
  },
  en: {
    roles: {
      AXButton: 'button',
      AXMenuButton: 'button',
      AXPopUpButton: 'button',
      AXLink: 'link',
      AXMenuItem: 'menu item',
      AXMenuBarItem: 'menu item',
      AXCheckBox: 'checkbox',
      AXRadioButton: 'option',
      AXTextField: 'field',
      AXTextArea: 'field',
      AXComboBox: 'field',
      AXWebArea: 'page',
    },
    other: 'item',
  },
});

/**
 * What the shell's `computer_careful` answer read on the screen, for the step that proposed
 * `action`: a click is said again with the control's own name (never the processor's), and any
 * other step gets a note on what the keys or the text would act on.
 */
const reading = (reason: string, action: ComputerAction): { seen?: string; text?: string } => {
  const [, role, ...name] = reason.split(':');
  if (role === undefined) return {};
  const label = name.join(':');
  if (action.kind === 'click' && label !== '') {
    return { text: said.computerClick(label, action.double) };
  }
  return { seen: strings.chat.computerSeen(NOUNS.roles[role] ?? NOUNS.other, label) };
};
/** T1b: the step targets an app ANOMANDER never acts on (`computer_blocked:<app>`). */
const BLOCKED = 'computer_blocked:';

/**
 * What became of an answer `answer` was given: `routine` for a step performed without asking (on
 * the way to the next one, not an answer to notify), `step` for any other answer to a step, and
 * `null` for an answer that belongs to no step.
 */
export type StepAnswer = 'routine' | 'step' | null;

export class ComputerTaskSession {
  /** The steps whose answer has not arrived, by request. */
  private readonly asked = new Map<string, Step>();
  /** The proposals the principal has not answered, by the reply that carries them. */
  private readonly proposed = new Map<string, Step & { action: ComputerAction; text: string }>();
  /** `running` as it is now, for what is decided between two renders. */
  private going = false;
  /**
   * One task at a time: starting a task or stopping one moves this on, and whatever belongs to
   * an earlier number is over. Its answers are shown, and nothing more is performed for it.
   */
  private run = 0;
  /** What the shell is doing on the computer: one capture or action at a time, in order. */
  private turns: Promise<unknown> = Promise.resolve();
  private busy = 0;

  private readonly deps: ComputerTaskDeps;

  constructor(deps: ComputerTaskDeps) {
    this.deps = deps;
  }

  /** A task is going on by itself: a step is being planned or performed. */
  get running(): boolean {
    return this.going;
  }

  /** Runs `work` on the computer once everything asked before it is over. */
  inTurn<T>(work: () => Promise<T>): Promise<T> {
    this.busy += 1;
    const turn = this.turns.then(work);
    this.turns = turn.then(
      () => {},
      () => {},
    );
    void this.turns.then(() => {
      this.busy -= 1;
    });
    return turn;
  }

  /**
   * Takes the answer to the request `requestId` when it was a step: the action it proposes is
   * shown, and performed at once when the daemon calls it routine.
   */
  answer(requestId: string, outcome: Outcome): StepAnswer {
    const step = this.asked.get(requestId);
    if (step === undefined) return null;
    this.asked.delete(requestId);
    // DK-10: an action is offered only in answer to a step the principal asked for.
    const action = outcome.type === 'reply' ? outcome.reply.computer : undefined;
    if (outcome.type === 'reply' && action !== undefined) {
      const { channelRef, text } = outcome.reply;
      const ended = step.run !== this.run;
      // DK-10 AC1: only a step the daemon calls routine goes without asking.
      const routine = outcome.reply.confirm === false && !ended;
      const proposal = { action, captureUrl: step.captureUrl, confirm: !routine, seen: null };
      this.deps.dispatch({ type: 'outcome', requestId, outcome, proposal });
      if (ended) {
        this.deps.dispatch({ type: 'refused', id: channelRef });
      } else {
        this.proposed.set(channelRef, { ...step, action, text });
        if (routine) {
          void this.perform(channelRef, false);
          return 'routine';
        }
        this.rest();
      }
    } else {
      this.deps.release(step.captureUrl);
      if (step.run === this.run) this.rest();
      this.deps.dispatch({ type: 'outcome', requestId, outcome });
    }
    return 'step';
  }

  /** Starts the task the reply `id` announced (DK-10): its first step, with the screen as it is. */
  async begin(id: string, text: string): Promise<void> {
    const computer = this.deps.computer();
    // One task at a time: this one ends the one before.
    this.abandon();
    const mine = this.run;
    let requestId: string | null = null;
    this.setRunning(computer !== undefined);
    try {
      if (computer !== undefined) {
        const jpeg = await this.inTurn(() => {
          if (mine !== this.run) throw ENDED;
          return computer.capture();
        });
        requestId = await this.step(mine, text, [], jpeg);
      }
    } catch (error) {
      if (error !== ENDED && mine === this.run) {
        this.deps.onProblem(NOTHING_DONE[String(error)] ?? strings.chat.screenFailed);
      }
    }
    if (requestId === null && mine === this.run) this.rest();
    this.deps.dispatch({ type: 'started', id, requestId });
  }

  /**
   * Performs the proposal of the reply `id`, once, then asks for the next step. `permitted` when
   * the principal allowed it; a routine step goes without.
   */
  async perform(id: string, permitted: boolean): Promise<void> {
    const computer = this.deps.computer();
    const proposal = this.proposed.get(id);
    if (computer === undefined || proposal === undefined) return;
    // Taken out first: a second press finds nothing to perform.
    this.proposed.delete(id);
    const mine = proposal.run;
    const { dispatch, onProblem } = this.deps;
    this.setRunning(true);
    dispatch({ type: 'allowed', id });
    let jpeg: ArrayBuffer;
    try {
      jpeg = await this.inTurn(() => {
        if (mine !== this.run) throw ENDED;
        return computer.perform(proposal.action, permitted);
      });
    } catch (error) {
      if (error === ENDED) {
        dispatch({ type: 'refused', id });
        return;
      }
      const current = mine === this.run;
      if (current) this.rest();
      const reason = String(error);
      if (reason.startsWith(BLOCKED)) {
        // Nothing was done, and nothing is: the task ends here.
        dispatch({ type: 'refused', id });
        if (current) onProblem(strings.chat.computerBlocked(reason.slice(BLOCKED.length)));
        return;
      }
      if (reason === CAREFUL || reason.startsWith(`${CAREFUL}:`)) {
        // Nothing was done: the step waits for the principal, as one of care.
        if (current) {
          this.proposed.set(id, proposal);
          dispatch({ type: 'not_performed', id, ...reading(reason, proposal.action) });
        } else {
          dispatch({ type: 'refused', id });
        }
        return;
      }
      const nothingDone = NOTHING_DONE[reason];
      if (nothingDone === undefined) {
        // It may have been performed: it is never offered again.
        dispatch({ type: 'performed', id, requestId: null });
        return;
      }
      if (current) {
        this.proposed.set(id, proposal);
        dispatch({ type: 'not_performed', id });
        onProblem(nothingDone);
      } else {
        dispatch({ type: 'refused', id });
      }
      return;
    }
    if (mine !== this.run) {
      // Performed, and the task ended meanwhile: no next step is asked for.
      dispatch({ type: 'performed_last', id });
      return;
    }
    let requestId: string | null = null;
    try {
      requestId = await this.step(mine, proposal.task, [...proposal.done, proposal.text], jpeg);
    } catch {
      // The action was performed and the next step could not leave.
    }
    if (mine !== this.run) {
      dispatch({ type: 'performed_last', id });
      return;
    }
    if (requestId === null) this.rest();
    dispatch({ type: 'performed', id, requestId });
  }

  /** The principal allowed the proposal of the reply `id` (DK-10 AC1). */
  allow(id: string): Promise<void> {
    return this.perform(id, true);
  }

  /** Stops the task at the proposal of the reply `id`; nothing is performed. */
  refuse(id: string): void {
    if (!this.proposed.delete(id)) return;
    this.deps.dispatch({ type: 'refused', id });
  }

  /** Stops the task that is running: nothing more is performed for it. */
  stop(): void {
    this.abandon();
    this.rest();
  }

  private setRunning(next: boolean): void {
    this.going = next;
    this.deps.onRunning(next);
  }

  /** The task no longer goes by itself: the app comes back, after any action still going. */
  private rest(): void {
    this.setRunning(false);
    const reveal = () => this.deps.computer()?.reveal();
    if (this.busy === 0) reveal();
    // By its turn another task may be going: then the app stays out of the way.
    else
      void this.inTurn(async () => {
        if (!this.going) reveal();
      });
  }

  /** Ends whatever task there is: its steps that waited for the principal are answered. */
  private abandon(): void {
    this.run += 1;
    for (const id of this.proposed.keys()) this.deps.dispatch({ type: 'refused', id });
    this.proposed.clear();
  }

  /** Sends one step of `task` with the screen as `jpeg` shows it; `null` when it could not leave. */
  private async step(
    of: number,
    task: string,
    done: string[],
    jpeg: ArrayBuffer,
  ): Promise<string | null> {
    const image = await this.deps.encode(jpeg);
    // The task ended while the screen was read: its step does not leave.
    if (of !== this.run) return null;
    const requestId = this.deps.send({ type: 'computer', task, image, done });
    if (requestId !== null) {
      const captureUrl = this.deps.captureUrl(jpeg);
      this.asked.set(requestId, { run: of, task, done, captureUrl });
    }
    return requestId;
  }
}
