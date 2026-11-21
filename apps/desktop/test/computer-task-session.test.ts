import { type ChatReply, type ComputerAction, strings as said } from '@anomander/protocol';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { NewRequest, Outcome } from '../src/chat/chat-client.ts';
import { type Computer, ComputerTaskSession } from '../src/chat/computer-task-session.ts';
import type { ConversationAction } from '../src/chat/conversation.ts';
import { strings } from '../src/strings.ts';

// DK-10 and T1b: a task on the computer, step by step, with no React and no socket: the shell,
// the daemon and the conversation are fakes driven by hand.

const TASK = 'Abre las notas y escribe la lista de la compra';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff]).buffer;
const CLICK: ComputerAction = { kind: 'click', x: 10, y: 20, double: false, target: 'Notas' };
const ENTER: ComputerAction = { kind: 'key', key: 'enter', modifiers: [] };

/** A promise settled by hand, for an action that is still going. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

/** Lets every pending turn and encoding run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const proposing = (
  requestId: string,
  action: ComputerAction,
  confirm: boolean,
  channelRef = `desktop:${requestId}`,
): Outcome => {
  const reply: ChatReply = {
    type: 'reply',
    inReplyTo: requestId,
    channelRef,
    text: `Paso de ${requestId}`,
    buttons: [],
    sentAt: '2026-11-21T10:00:00.000Z',
    computer: action,
    confirm,
  };
  return { type: 'reply', reply };
};

let actions: ConversationAction[];
let sent: NewRequest[];
let problems: string[];
let running: boolean[];
let computer: {
  capture: Mock<Computer['capture']>;
  perform: Mock<Computer['perform']>;
  reveal: Mock<Computer['reveal']>;
};
let session: ComputerTaskSession;

beforeEach(() => {
  actions = [];
  sent = [];
  problems = [];
  running = [];
  computer = {
    capture: vi.fn(async () => JPEG),
    perform: vi.fn(async () => JPEG),
    reveal: vi.fn(),
  };
  session = new ComputerTaskSession({
    dispatch: (action) => actions.push(action),
    send: (request) => {
      sent.push(request);
      return `step-${sent.length}`;
    },
    computer: () => computer,
    onProblem: (text) => problems.push(text),
    onRunning: (next) => running.push(next),
    encode: async () => ({ mimeType: 'image/jpeg', data: '/9j/' }),
    captureUrl: () => 'blob:capture',
    release: vi.fn(),
  });
});

/** Starts the task announced by the reply `reply-1`; its first step leaves as `step-1`. */
const begin = async () => {
  await session.begin('reply-1', TASK);
  expect(sent).toEqual([
    { type: 'computer', task: TASK, image: { mimeType: 'image/jpeg', data: '/9j/' }, done: [] },
  ]);
  expect(actions).toEqual([{ type: 'started', id: 'reply-1', requestId: 'step-1' }]);
  actions = [];
};

describe('ComputerTaskSession', () => {
  it('performs a routine step without asking, then sends the next one', async () => {
    await begin();

    expect(session.answer('step-1', proposing('step-1', CLICK, false))).toBe('routine');
    await settle();

    expect(computer.perform).toHaveBeenCalledWith(CLICK, false);
    expect(sent[1]).toMatchObject({ type: 'computer', task: TASK, done: ['Paso de step-1'] });
    expect(actions).toEqual([
      {
        type: 'outcome',
        requestId: 'step-1',
        outcome: proposing('step-1', CLICK, false),
        proposal: { action: CLICK, captureUrl: 'blob:capture', confirm: false, seen: null },
      },
      { type: 'allowed', id: 'desktop:step-1' },
      { type: 'performed', id: 'desktop:step-1', requestId: 'step-2' },
    ]);
    expect(session.running).toBe(true);
    expect(computer.reveal).not.toHaveBeenCalled();
  });

  it('waits for Permitir when the shell answers careful, saying the control it read', async () => {
    await begin();
    computer.perform.mockRejectedValueOnce('computer_careful:AXButton:Enviar');

    session.answer('step-1', proposing('step-1', CLICK, false));
    await settle();

    expect(actions.at(-1)).toEqual({
      type: 'not_performed',
      id: 'desktop:step-1',
      text: said.computerClick('Enviar', false),
    });
    expect(session.running).toBe(false);
    expect(computer.reveal).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
  });

  it('notes what a careful key would act on', async () => {
    await begin();
    computer.perform.mockRejectedValueOnce('computer_careful:AXTextField:Para');

    session.answer('step-1', proposing('step-1', ENTER, false));
    await settle();

    expect(actions.at(-1)).toEqual({
      type: 'not_performed',
      id: 'desktop:step-1',
      seen: strings.chat.computerSeen('campo', 'Para'),
    });
  });

  it('performs a step of care only once allowed, and then as permitted', async () => {
    await begin();
    computer.perform.mockRejectedValueOnce('computer_careful');
    session.answer('step-1', proposing('step-1', ENTER, false));
    await settle();
    expect(actions.at(-1)).toEqual({ type: 'not_performed', id: 'desktop:step-1' });

    await session.allow('desktop:step-1');

    expect(computer.perform.mock.calls).toEqual([
      [ENTER, false],
      [ENTER, true],
    ]);
    expect(actions.at(-1)).toEqual({
      type: 'performed',
      id: 'desktop:step-1',
      requestId: 'step-2',
    });
    expect(session.running).toBe(true);
  });

  it('asks before a step the daemon calls careful, and performs it as permitted', async () => {
    await begin();

    expect(session.answer('step-1', proposing('step-1', ENTER, true))).toBe('step');
    await settle();
    expect(computer.perform).not.toHaveBeenCalled();
    expect(session.running).toBe(false);

    await session.allow('desktop:step-1');
    // A second press finds nothing to perform.
    await session.allow('desktop:step-1');

    expect(computer.perform.mock.calls).toEqual([[ENTER, true]]);
  });

  it('ends the task on a blocked app, with its name', async () => {
    await begin();
    computer.perform.mockRejectedValueOnce('computer_blocked:Acceso a Llaveros');

    session.answer('step-1', proposing('step-1', CLICK, false));
    await settle();

    expect(actions.at(-1)).toEqual({ type: 'refused', id: 'desktop:step-1' });
    expect(problems).toEqual([strings.chat.computerBlocked('Acceso a Llaveros')]);
    expect(session.running).toBe(false);
    await session.allow('desktop:step-1');
    expect(computer.perform).toHaveBeenCalledOnce();
  });

  it('stops mid-task: a waiting proposal is refused and nothing more is performed', async () => {
    await begin();
    session.answer('step-1', proposing('step-1', ENTER, true));

    session.stop();

    expect(actions.at(-1)).toEqual({ type: 'refused', id: 'desktop:step-1' });
    expect(running.at(-1)).toBe(false);
    await session.allow('desktop:step-1');
    expect(computer.perform).not.toHaveBeenCalled();
  });

  it('stops while an action is going: it is the last, and no next step leaves', async () => {
    await begin();
    const action = deferred<ArrayBuffer>();
    computer.perform.mockReturnValueOnce(action.promise);
    session.answer('step-1', proposing('step-1', CLICK, false));
    await settle();

    session.stop();
    expect(computer.reveal).not.toHaveBeenCalled();
    action.resolve(JPEG);
    await settle();

    expect(actions.at(-1)).toEqual({ type: 'performed_last', id: 'desktop:step-1' });
    expect(sent).toHaveLength(1);
    // The app comes back once the action is over.
    expect(computer.reveal).toHaveBeenCalledOnce();
  });

  it('never offers again an action that failed and may have been performed', async () => {
    await begin();
    computer.perform.mockRejectedValueOnce('perform_failed');

    session.answer('step-1', proposing('step-1', CLICK, false));
    await settle();

    expect(actions.at(-1)).toEqual({ type: 'performed', id: 'desktop:step-1', requestId: null });
    expect(session.running).toBe(false);
    await session.allow('desktop:step-1');
    expect(computer.perform).toHaveBeenCalledOnce();
  });

  it('offers again an action macOS did not allow, saying why', async () => {
    await begin();
    computer.perform.mockRejectedValueOnce('computer_permission');

    session.answer('step-1', proposing('step-1', CLICK, false));
    await settle();

    expect(actions.at(-1)).toEqual({ type: 'not_performed', id: 'desktop:step-1' });
    expect(problems).toEqual([strings.chat.computerPermission]);
    await session.allow('desktop:step-1');
    expect(computer.perform.mock.calls.at(-1)).toEqual([CLICK, true]);
  });

  it('leaves every answer that is not a step to the chat', () => {
    expect(session.answer('text-1', { type: 'done' })).toBeNull();
    expect(actions).toEqual([]);
  });
});
