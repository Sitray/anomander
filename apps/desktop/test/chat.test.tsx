// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatScreen } from '../src/chat/ChatScreen.tsx';
import type { DaemonStatus, LocalChannel } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { CHANNEL, RUNNING, replyTo, STARTING, stopped, TOKEN } from './fixtures.ts';

// DK-4: the chat, from the keyboard to the socket and back, against a WebSocket driven by hand.
const S19 = 'Esa pregunta ya no está abierta.';

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  // jsdom has no object URLs; the chat only needs something to put in an <img>.
  let urls = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++urls}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderChat = (daemon: DaemonStatus = RUNNING, channel: LocalChannel | null = CHANNEL) =>
  render(<ChatScreen daemon={daemon} channel={channel} />);

/** A chat whose connection to the daemon is open. */
const openChat = (): FakeWebSocket => {
  renderChat();
  act(() => FakeWebSocket.last.open());
  return FakeWebSocket.last;
};

const composer = (): HTMLTextAreaElement => screen.getByLabelText(strings.chat.message);

const type = (text: string): void => {
  fireEvent.change(composer(), { target: { value: text } });
};

const pressEnter = (init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(composer(), { key: 'Enter', ...init });
};

const say = (text: string): void => {
  type(text);
  pressEnter();
};

const image = (name: string, type = 'image/png'): File => new File(['bytes'], name, { type });
/** `bytes` in base64. */
const BYTES = 'Ynl0ZXM=';

const sentRequest = async (socket: FakeWebSocket, count = 1) => {
  await waitFor(() => expect(socket.requests).toHaveLength(count));
  return socket.lastRequest;
};

describe('an empty chat', () => {
  it('says what can be done here', () => {
    openChat();

    expect(screen.getByText(strings.chat.emptyTitle)).toBeTruthy();
    // As written: the example's non-breaking spaces must not be folded into plain ones.
    expect(screen.getByText(strings.chat.emptyBody, { normalizer: (text) => text })).toBeTruthy();
  });
});

describe('typing', () => {
  it('sends the text on Enter, shows it and clears the composer (DK-4 AC1)', async () => {
    const socket = openChat();
    say('23 € cena');

    expect(await sentRequest(socket)).toMatchObject({ type: 'text', text: '23 € cena' });
    expect(screen.getByText('23 € cena')).toBeTruthy();
    expect(composer().value).toBe('');
    expect(screen.queryByText(strings.chat.emptyTitle)).toBeNull();
  });

  it('keeps Shift+Enter for a new line', () => {
    const socket = openChat();
    type('23 € cena');
    pressEnter({ shiftKey: true });

    expect(socket.sent).toEqual([]);
    expect(composer().value).toBe('23 € cena');
  });

  it('ignores Enter while an input method is composing', () => {
    const socket = openChat();
    type('にほん');
    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(composer(), { key: 'Enter', keyCode: 229 });

    expect(socket.sent).toEqual([]);
  });

  it('sends nothing for a blank message', () => {
    const socket = openChat();
    say('   \n ');

    expect(socket.sent).toEqual([]);
  });

  it('takes no more than the 4096 characters the daemon accepts', () => {
    openChat();

    expect(composer().maxLength).toBe(4096);
  });

  it('shows that the daemon is working until the answer arrives', async () => {
    const socket = openChat();
    say('23 € cena');
    const request = await sentRequest(socket);

    expect(screen.getByText(strings.chat.thinking)).toBeTruthy();
    act(() => socket.receive(replyTo(request.id)));
    expect(screen.queryByText(strings.chat.thinking)).toBeNull();
  });

  it('settles a request the daemon handled without a reply', async () => {
    const socket = openChat();
    say('hola');
    const request = await sentRequest(socket);
    act(() => socket.receive({ type: 'done', inReplyTo: request.id }));

    expect(screen.queryByText(strings.chat.thinking)).toBeNull();
    expect(screen.queryByText(strings.chat.notSent)).toBeNull();
  });
});

describe('a reply', () => {
  it('shows its text exactly as received: never as HTML or Markdown', async () => {
    const socket = openChat();
    say('hola');
    const request = await sentRequest(socket);
    const text = '<b>Hecho</b> <img src="x" onerror="alert(1)">\n**23,00 €** en [cenas](http://x)';
    act(() => socket.receive(replyTo(request.id, { text })));

    const log = screen.getByRole('log');
    const shown = within(log).getByText((_, element) => element?.textContent === text);
    expect(shown.textContent).toBe(text);
    expect(log.querySelector('b, img, a, strong')).toBeNull();
  });

  it('is announced to assistive technology as it arrives', () => {
    openChat();

    expect(screen.getByRole('log').getAttribute('aria-live')).toBe('polite');
  });
});

describe('a question with buttons (DK-4 AC3)', () => {
  const ask = async (socket: FakeWebSocket) => {
    say('mercadona 40');
    const request = await sentRequest(socket);
    const question = replyTo(request.id, {
      text: '¿Mercadona siempre es supermercado?',
      buttons: [
        { label: 'Sí', data: 'policy:yes:7' },
        { label: 'No', data: 'policy:no:7' },
      ],
    });
    act(() => socket.receive(question));
    return question;
  };

  it("sends a press with its reply's channelRef and disables the buttons while waiting", async () => {
    const socket = openChat();
    const question = await ask(socket);
    const yes = screen.getByRole<HTMLButtonElement>('button', { name: 'Sí' });
    const no = screen.getByRole<HTMLButtonElement>('button', { name: 'No' });
    fireEvent.click(yes);

    expect(socket.lastRequest).toMatchObject({
      type: 'button',
      data: 'policy:yes:7',
      channelRef: question.channelRef,
    });
    expect(yes.disabled).toBe(true);
    expect(no.disabled).toBe(true);

    fireEvent.click(no);
    expect(socket.requests).toHaveLength(2);
  });

  it('shows the answer as a new message, S-19 included', async () => {
    const socket = openChat();
    await ask(socket);
    fireEvent.click(screen.getByRole('button', { name: 'Sí' }));
    act(() => socket.receive(replyTo(socket.lastRequest.id, { text: S19 })));

    expect(screen.getByText(S19)).toBeTruthy();
    expect(screen.getByText('¿Mercadona siempre es supermercado?')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sí' }).disabled).toBe(false);
  });

  it('says when a press was not sent and lets it be pressed again', async () => {
    const socket = openChat();
    await ask(socket);
    fireEvent.click(screen.getByRole('button', { name: 'Sí' }));
    act(() => socket.receive({ type: 'rejected', inReplyTo: socket.lastRequest.id }));

    expect(screen.getByText(strings.chat.pressNotSent)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sí' }).disabled).toBe(false);
  });

  it('says when it is unknown whether a press arrived', async () => {
    const socket = openChat();
    await ask(socket);
    fireEvent.click(screen.getByRole('button', { name: 'Sí' }));
    act(() => socket.drop());

    expect(screen.getByText(strings.chat.pressUnknown)).toBeTruthy();
  });

  it('does not offer a link button it cannot open as a working button', async () => {
    const socket = openChat();
    say('/login');
    const request = await sentRequest(socket);
    act(() =>
      socket.receive(
        replyTo(request.id, { buttons: [{ label: 'Abrir', url: 'https://example.com/login' }] }),
      ),
    );

    expect(screen.queryByRole('button', { name: 'Abrir' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(strings.chat.linkOnlyInTelegram('Abrir'))).toBeTruthy();
  });
});

describe('delivery honesty', () => {
  it('says a rejected message was not sent and sends it again when asked', async () => {
    const socket = openChat();
    say('23 € cena');
    const request = await sentRequest(socket);
    act(() => socket.receive({ type: 'rejected', inReplyTo: request.id }));

    expect(screen.getByText(strings.chat.notSent)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: strings.chat.sendAgain }));

    const again = await sentRequest(socket, 2);
    expect(again).toMatchObject({ type: 'text', text: '23 € cena' });
    expect(again.id).not.toBe(request.id);
    expect(screen.queryByText(strings.chat.notSent)).toBeNull();
    expect(screen.getAllByText('23 € cena')).toHaveLength(1);
  });

  it('says it is unknown whether a message arrived when the connection is lost, and offers no resend', async () => {
    const socket = openChat();
    say('23 € cena');
    await sentRequest(socket);
    act(() => socket.drop());

    expect(screen.getByText(strings.chat.unknown)).toBeTruthy();
    expect(screen.queryByText(strings.chat.notSent)).toBeNull();
    expect(screen.queryByRole('button', { name: strings.chat.sendAgain })).toBeNull();
    expect(screen.queryByText(strings.chat.thinking)).toBeNull();
  });

  it('keeps the conversation in memory only', async () => {
    const socket = openChat();
    say('23 € cena');
    const request = await sentRequest(socket);
    act(() => socket.receive(replyTo(request.id)));

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('never puts the token in the page', () => {
    openChat();

    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
  });
});

describe('receipts (DK-4 AC2)', () => {
  const attachmentList = () => screen.getByRole('list', { name: strings.chat.attachments });

  it('holds dropped images in the composer and sends them as one receipt with the text as caption', async () => {
    const socket = openChat();
    fireEvent.drop(screen.getByRole('log'), {
      dataTransfer: { files: [image('uno.png'), image('dos.jpg', 'image/jpeg')], types: ['Files'] },
    });

    expect(within(attachmentList()).getAllByRole('listitem')).toHaveLength(2);
    expect(socket.sent).toEqual([]);

    say('la compra');
    expect(await sentRequest(socket)).toMatchObject({
      type: 'receipt',
      images: [
        { mimeType: 'image/png', data: BYTES },
        { mimeType: 'image/jpeg', data: BYTES },
      ],
      caption: 'la compra',
    });
    expect(screen.queryByRole('list', { name: strings.chat.attachments })).toBeNull();
    expect(composer().value).toBe('');
  });

  it('sends a receipt with no caption when nothing was typed', async () => {
    const socket = openChat();
    fireEvent.paste(composer(), { clipboardData: { files: [image('pegada.png')] } });
    fireEvent.click(screen.getByRole('button', { name: strings.chat.send }));

    expect(await sentRequest(socket)).toMatchObject({ type: 'receipt', caption: null });
  });

  it("shows the thumbnails in the principal's message", async () => {
    const socket = openChat();
    fireEvent.change(screen.getByLabelText(strings.chat.attach, { selector: 'input' }), {
      target: { files: [image('ticket.png')] },
    });
    pressEnter();
    await sentRequest(socket);

    const thumbnail = within(screen.getByRole('log')).getByRole<HTMLImageElement>('img', {
      name: 'ticket.png',
    });
    expect(thumbnail.src).toMatch(/^blob:/);
  });

  it('removes an attachment before sending', () => {
    openChat();
    fireEvent.paste(composer(), { clipboardData: { files: [image('uno.png'), image('dos.png')] } });
    fireEvent.click(screen.getByRole('button', { name: strings.chat.removeAttachment('uno.png') }));

    expect(within(attachmentList()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('sends a file that is not an image as it is, for the daemon to answer (DK-4 AC6)', async () => {
    const socket = openChat();
    fireEvent.paste(composer(), {
      clipboardData: { files: [new File(['bytes'], 'factura.pdf', { type: 'application/pdf' })] },
    });
    pressEnter();

    expect(await sentRequest(socket)).toMatchObject({
      type: 'receipt',
      images: [{ mimeType: 'application/pdf', data: BYTES }],
    });
  });

  it('keeps at most 10 files and says so', () => {
    openChat();
    const files = Array.from({ length: 12 }, (_, index) => image(`ticket-${index}.png`));
    fireEvent.paste(composer(), { clipboardData: { files } });

    expect(within(attachmentList()).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText(strings.chat.tooMany)).toBeTruthy();
  });

  it('sends a rejected receipt again with its images', async () => {
    const socket = openChat();
    fireEvent.paste(composer(), { clipboardData: { files: [image('uno.png')] } });
    pressEnter();
    const request = await sentRequest(socket);
    act(() => socket.receive({ type: 'rejected', inReplyTo: request.id }));
    fireEvent.click(screen.getByRole('button', { name: strings.chat.sendAgain }));

    expect(await sentRequest(socket, 2)).toMatchObject({
      type: 'receipt',
      images: [{ mimeType: 'image/png', data: BYTES }],
    });
  });
});

describe('without a channel', () => {
  it.each([
    [stopped('stopped_by_principal'), strings.chat.disabled.stopped],
    [stopped('not_configured'), strings.chat.disabled.notConfigured],
    [stopped(null, 'spawn node ENOENT'), strings.chat.disabled.stopped],
    [STARTING, strings.chat.disabled.starting],
    [{ state: 'failing', reason: null, lastError: 'boom' } as const, strings.chat.disabled.failing],
  ])('disables the composer and says why: %j', (daemon, reason) => {
    renderChat(daemon, null);

    expect(composer().disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: strings.chat.send }).disabled,
    ).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
  });

  it('holds what was typed, without sending, while the connection is not open yet', () => {
    renderChat();
    say('23 € cena');

    expect(FakeWebSocket.last.sent).toEqual([]);
    expect(composer().value).toBe('23 € cena');
    expect(screen.getByText(strings.chat.disabled.connecting)).toBeTruthy();
  });

  it('connects again when a restarted daemon has a new port', () => {
    const { rerender } = renderChat();
    act(() => FakeWebSocket.last.open());
    rerender(
      <ChatScreen daemon={RUNNING} channel={{ url: 'ws://127.0.0.1:5999', token: TOKEN }} />,
    );

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.last.url).toBe('ws://127.0.0.1:5999');
  });
});

describe('the screen', () => {
  const capture = () => new TextEncoder().encode('bytes').buffer as ArrayBuffer;
  const look = () => screen.getByRole('button', { name: strings.chat.screen });
  const openWithScreen = (onCaptureScreen: () => Promise<ArrayBuffer>): FakeWebSocket => {
    render(<ChatScreen daemon={RUNNING} channel={CHANNEL} onCaptureScreen={onCaptureScreen} />);
    act(() => FakeWebSocket.last.open());
    return FakeWebSocket.last;
  };
  const captured = () =>
    waitFor(() =>
      expect(screen.getByRole('img', { name: strings.chat.screenCapture })).toBeTruthy(),
    );

  it('offers no look at the screen where the window cannot capture it', () => {
    openChat();

    expect(screen.queryByRole('button', { name: strings.chat.screen })).toBeNull();
  });

  it('shows the capture before anything is sent, and sends it with the question', async () => {
    const socket = openWithScreen(async () => capture());
    fireEvent.click(look());
    await captured();
    expect(socket.sent).toEqual([]);

    say('¿De quién es este correo?');

    expect(await sentRequest(socket)).toMatchObject({
      type: 'screen',
      text: '¿De quién es este correo?',
      image: { mimeType: 'image/jpeg', data: BYTES },
    });
    expect(screen.queryByRole('list', { name: strings.chat.attachments })).toBeNull();
  });

  it('asks what is on the screen when nothing was typed', async () => {
    const socket = openWithScreen(async () => capture());
    fireEvent.click(look());
    await captured();
    fireEvent.click(screen.getByRole('button', { name: strings.chat.send }));

    expect(await sentRequest(socket)).toMatchObject({
      type: 'screen',
      text: strings.chat.screenQuestion,
    });
    expect(within(screen.getByRole('log')).getByText(strings.chat.screenQuestion)).toBeTruthy();
  });

  it('can be taken back before sending', async () => {
    const socket = openWithScreen(async () => capture());
    fireEvent.click(look());
    await captured();
    fireEvent.click(
      screen.getByRole('button', {
        name: strings.chat.removeAttachment(strings.chat.screenCapture),
      }),
    );

    say('23 € cena');

    expect(await sentRequest(socket)).toMatchObject({ type: 'text', text: '23 € cena' });
  });

  it('keeps a single capture: a new look replaces the last one', async () => {
    openWithScreen(async () => capture());
    fireEvent.click(look());
    await captured();
    fireEvent.click(look());

    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole('img', { name: strings.chat.screenCapture })).toHaveLength(1);
  });

  it('does not mix a capture with receipts', async () => {
    openWithScreen(async () => capture());
    fireEvent.paste(composer(), { clipboardData: { files: [image('ticket.png')] } });
    fireEvent.click(look());

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.screenAlone),
    );
    expect(screen.queryByRole('img', { name: strings.chat.screenCapture })).toBeNull();
  });

  it('says how to allow it when macOS does not let the app see the screen', async () => {
    openWithScreen(async () => {
      throw 'screen_permission';
    });
    fireEvent.click(look());

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.screenPermission),
    );
  });

  it('says when the capture failed for another reason', async () => {
    openWithScreen(async () => {
      throw 'screencapture exited with 1';
    });
    fireEvent.click(look());

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.screenFailed),
    );
  });
});

describe('a task on the computer (DK-10)', () => {
  const jpeg = () => new TextEncoder().encode('bytes').buffer as ArrayBuffer;
  const CLICK = { kind: 'click', x: 512, y: 80, double: false, target: 'Enviar' } as const;
  const PROPOSAL = 'Quiero hacer clic en «Enviar».';
  const task = 'Envía el correo que tengo abierto';

  const openWithComputer = (
    perform: (action: unknown) => Promise<ArrayBuffer> = async () => jpeg(),
    capture: () => Promise<ArrayBuffer> = async () => jpeg(),
  ) => {
    const onCaptureScreen = vi.fn(capture);
    const onPerformAction = vi.fn(perform);
    const onReveal = vi.fn();
    const onTaskRunning = vi.fn();
    /** Stops the task as the menu bar's "Detener tarea" does. */
    let stopFromMenu = () => {};
    render(
      <ChatScreen
        daemon={RUNNING}
        channel={CHANNEL}
        onCaptureScreen={onCaptureScreen}
        onPerformAction={onPerformAction}
        onReveal={onReveal}
        onTaskRunning={onTaskRunning}
        subscribeStop={(stop) => {
          stopFromMenu = stop;
          return () => {};
        }}
      />,
    );
    act(() => FakeWebSocket.last.open());
    return {
      socket: FakeWebSocket.last,
      onCaptureScreen,
      onPerformAction,
      onReveal,
      onTaskRunning,
      stopFromMenu: () => act(() => stopFromMenu()),
    };
  };
  const mode = () => screen.getByRole('button', { name: strings.chat.computer });
  const allow = () =>
    screen.getByRole<HTMLButtonElement>('button', { name: strings.chat.computerAllow });
  const refuse = () =>
    screen.getByRole<HTMLButtonElement>('button', { name: strings.chat.computerRefuse });
  /** Asks for the task and has the daemon propose `computer` for it. */
  const proposed = async (socket: FakeWebSocket, computer: unknown = CLICK, text = PROPOSAL) => {
    fireEvent.click(mode());
    say(task);
    const request = await sentRequest(socket);
    act(() => socket.receive(replyTo(request.id, { text, computer } as never)));
    return request;
  };

  it('offers no control of the computer where the window cannot perform an action', () => {
    openChat();

    expect(screen.queryByRole('button', { name: strings.chat.computer })).toBeNull();
  });

  it('says what the mode means before anything is asked, and can be left', () => {
    openWithComputer();
    fireEvent.click(mode());

    expect(mode().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(strings.chat.computerMode)).toBeTruthy();

    fireEvent.click(mode());
    expect(screen.queryByText(strings.chat.computerMode)).toBeNull();
  });

  it('sends the task with the screen as it is, and performs nothing', async () => {
    const { socket, onCaptureScreen, onPerformAction } = openWithComputer();
    fireEvent.click(mode());
    say(task);

    expect(await sentRequest(socket)).toEqual({
      id: expect.any(String),
      type: 'computer',
      task,
      image: { mimeType: 'image/jpeg', data: BYTES },
      done: [],
    });
    expect(onCaptureScreen).toHaveBeenCalledTimes(1);
    expect(onPerformAction).not.toHaveBeenCalled();
    // One task at a time: the next message is a plain one again.
    expect(mode().getAttribute('aria-pressed')).toBe('false');
  });

  it('AC1: shows the proposed action and waits; allowing it performs exactly that action and asks for the next step', async () => {
    const { socket, onPerformAction } = openWithComputer();
    await proposed(socket);

    expect(screen.getByText(PROPOSAL)).toBeTruthy();
    expect(screen.getByRole('img', { name: strings.chat.computerPreview })).toBeTruthy();
    expect(onPerformAction).not.toHaveBeenCalled();
    expect(socket.requests).toHaveLength(1);

    fireEvent.click(allow());

    expect(await sentRequest(socket, 2)).toMatchObject({
      type: 'computer',
      task,
      image: { mimeType: 'image/jpeg', data: BYTES },
      done: [PROPOSAL],
    });
    expect(onPerformAction).toHaveBeenCalledTimes(1);
    expect(onPerformAction).toHaveBeenCalledWith(CLICK, true);
    expect(allow().disabled).toBe(true);
    expect(refuse().disabled).toBe(true);
  });

  it('carries every step done so far to the next one', async () => {
    const { socket } = openWithComputer();
    await proposed(socket);
    fireEvent.click(allow());
    const second = await sentRequest(socket, 2);
    const typing = { kind: 'type', text: 'Hola' };
    act(() =>
      socket.receive(
        replyTo(second.id, { text: 'Quiero escribir: «Hola»', computer: typing } as never),
      ),
    );

    fireEvent.click(
      screen
        .getAllByRole<HTMLButtonElement>('button', { name: strings.chat.computerAllow })
        .filter((button) => !button.disabled)[0] as HTMLButtonElement,
    );

    expect(await sentRequest(socket, 3)).toMatchObject({
      done: [PROPOSAL, 'Quiero escribir: «Hola»'],
    });
  });

  it('stopping performs nothing and asks for nothing more', async () => {
    const { socket, onPerformAction } = openWithComputer();
    await proposed(socket);

    fireEvent.click(refuse());

    expect(screen.getByText(strings.chat.computerRefused)).toBeTruthy();
    expect(allow().disabled).toBe(true);
    await act(async () => {});
    expect(onPerformAction).not.toHaveBeenCalled();
    expect(socket.requests).toHaveLength(1);
  });

  it('performs an allowed action once, however many times it is pressed', async () => {
    const { socket, onPerformAction } = openWithComputer();
    await proposed(socket);

    fireEvent.click(allow());
    fireEvent.click(allow());
    await sentRequest(socket, 2);

    expect(onPerformAction).toHaveBeenCalledTimes(1);
  });

  it('shows no buttons when the daemon ends the task in words', async () => {
    const { socket } = openWithComputer();
    fireEvent.click(mode());
    say(task);
    const request = await sentRequest(socket);
    act(() => socket.receive(replyTo(request.id, { text: 'Correo enviado.' })));

    expect(screen.getByText('Correo enviado.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: strings.chat.computerAllow })).toBeNull();
  });

  it('never offers an action the principal did not ask a task for', async () => {
    const { socket, onPerformAction } = openWithComputer();
    say('23 € cena');
    const request = await sentRequest(socket);
    act(() => socket.receive(replyTo(request.id, { text: PROPOSAL, computer: CLICK } as never)));

    expect(screen.getByText(PROPOSAL)).toBeTruthy();
    expect(screen.queryByRole('button', { name: strings.chat.computerAllow })).toBeNull();
    expect(onPerformAction).not.toHaveBeenCalled();
  });

  it('says how to allow it when macOS does not let the app use the computer, and nothing was done', async () => {
    const { socket } = openWithComputer(async () => {
      throw 'computer_permission';
    });
    await proposed(socket);

    fireEvent.click(allow());

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.computerPermission),
    );
    // Nothing was done, so it can be allowed again once macOS lets it.
    expect(allow().disabled).toBe(false);
    expect(socket.requests).toHaveLength(1);
  });

  it('does not offer the action again when it may have been done', async () => {
    const { socket } = openWithComputer(async () => {
      throw 'the capture failed: exit status: 1';
    });
    await proposed(socket);

    fireEvent.click(allow());

    await waitFor(() => expect(screen.getByText(strings.chat.computerUnknown)).toBeTruthy());
    expect(allow().disabled).toBe(true);
    expect(socket.requests).toHaveLength(1);
  });

  it('does not offer the action again when the connection was lost after doing it', async () => {
    const { socket } = openWithComputer();
    await proposed(socket);
    fireEvent.click(allow());
    await sentRequest(socket, 2);

    act(() => socket.drop());

    expect(screen.getByText(strings.chat.computerUnknown)).toBeTruthy();
    expect(allow().disabled).toBe(true);
  });

  it('a task that could not capture the screen was not sent', async () => {
    const { socket } = openWithComputer(
      async () => jpeg(),
      async () => {
        throw 'screen_permission';
      },
    );
    fireEvent.click(mode());
    say(task);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.screenPermission),
    );
    expect(screen.getByText(strings.chat.notSent)).toBeTruthy();
    expect(socket.requests).toEqual([]);
  });

  it('a task goes without files', async () => {
    const { socket } = openWithComputer();
    fireEvent.paste(composer(), { clipboardData: { files: [image('ticket.png')] } });
    fireEvent.click(mode());
    say(task);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.computerAlone),
    );
    expect(socket.requests).toEqual([]);
  });

  describe('a routine step', () => {
    const stop = () => screen.queryByRole('button', { name: strings.chat.computerStop });
    /** Asks for the task; the daemon answers `computer` as a routine step. */
    const routine = async (socket: FakeWebSocket) => {
      fireEvent.click(mode());
      say(task);
      const request = await sentRequest(socket);
      act(() =>
        socket.receive(
          replyTo(request.id, { text: PROPOSAL, computer: CLICK, confirm: false } as never),
        ),
      );
    };

    it('is performed without asking, shown as it is, and the task goes on', async () => {
      const { socket, onPerformAction } = openWithComputer();
      await routine(socket);

      expect(await sentRequest(socket, 2)).toMatchObject({ type: 'computer', done: [PROPOSAL] });
      expect(onPerformAction).toHaveBeenCalledTimes(1);
      expect(onPerformAction).toHaveBeenCalledWith(CLICK, true);
      expect(screen.getByText(PROPOSAL)).toBeTruthy();
      expect(screen.getByText(strings.chat.computerAuto)).toBeTruthy();
      expect(screen.queryByRole('button', { name: strings.chat.computerAllow })).toBeNull();
    });

    it('is asked for all the same unless the daemon says it is routine', async () => {
      const { socket, onPerformAction } = openWithComputer();
      fireEvent.click(mode());
      say(task);
      const request = await sentRequest(socket);
      act(() =>
        socket.receive(
          replyTo(request.id, { text: PROPOSAL, computer: CLICK, confirm: true } as never),
        ),
      );
      await act(async () => {});

      expect(onPerformAction).not.toHaveBeenCalled();
      expect(allow().disabled).toBe(false);
    });

    it('offers to stop the task while it runs, and not once it waits or ends', async () => {
      const { socket } = openWithComputer();
      expect(stop()).toBeNull();
      await routine(socket);
      const second = await sentRequest(socket, 2);
      expect(stop()).not.toBeNull();

      // A step of care: the task waits for the principal, with its own way to stop.
      act(() =>
        socket.receive(
          replyTo(second.id, {
            text: 'Quiero pulsar Intro.',
            computer: { kind: 'key', key: 'enter', modifiers: [] },
          } as never),
        ),
      );
      expect(stop()).toBeNull();

      fireEvent.click(allow());
      const third = await sentRequest(socket, 3);
      expect(stop()).not.toBeNull();
      act(() => socket.receive(replyTo(third.id, { text: 'Hecho.' })));
      expect(stop()).toBeNull();
    });

    it('stopping the task performs nothing more, even a routine step already on its way', async () => {
      const { socket, onPerformAction } = openWithComputer();
      fireEvent.click(mode());
      say(task);
      const request = await sentRequest(socket);

      fireEvent.click(stop() as HTMLElement);
      act(() =>
        socket.receive(
          replyTo(request.id, { text: PROPOSAL, computer: CLICK, confirm: false } as never),
        ),
      );
      await act(async () => {});

      expect(onPerformAction).not.toHaveBeenCalled();
      expect(screen.getByText(strings.chat.computerRefused)).toBeTruthy();
      expect(socket.requests).toHaveLength(1);
      expect(stop()).toBeNull();
    });

    it('a new task runs again after one was stopped', async () => {
      const { socket, onPerformAction } = openWithComputer();
      fireEvent.click(mode());
      say(task);
      await sentRequest(socket);
      fireEvent.click(stop() as HTMLElement);

      fireEvent.click(mode());
      say('Abre Chrome');
      const again = await sentRequest(socket, 2);
      act(() =>
        socket.receive(
          replyTo(again.id, { text: PROPOSAL, computer: CLICK, confirm: false } as never),
        ),
      );

      await sentRequest(socket, 3);
      expect(onPerformAction).toHaveBeenCalledTimes(1);
    });

    it('asks for permission after all when macOS did not let it be performed', async () => {
      let allowedByMac = false;
      const { socket, onPerformAction } = openWithComputer(async () => {
        if (!allowedByMac) throw 'computer_permission';
        return jpeg();
      });
      await routine(socket);

      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe(strings.chat.computerPermission),
      );
      expect(socket.requests).toHaveLength(1);
      expect(stop()).toBeNull();

      allowedByMac = true;
      fireEvent.click(allow());
      await sentRequest(socket, 2);
      expect(onPerformAction).toHaveBeenCalledTimes(2);
    });

    const routineReply = (id: string, text = PROPOSAL) =>
      replyTo(id, { text, computer: CLICK, confirm: false } as never);

    it('a stopped task stays stopped when another one starts', async () => {
      const { socket, onPerformAction } = openWithComputer();
      fireEvent.click(mode());
      say(task);
      const first = await sentRequest(socket);
      fireEvent.click(stop() as HTMLElement);
      fireEvent.click(mode());
      say('Abre Chrome');
      await sentRequest(socket, 2);

      act(() => socket.receive(routineReply(first.id)));
      await act(async () => {});

      expect(onPerformAction).not.toHaveBeenCalled();
      expect(screen.getByText(strings.chat.computerRefused)).toBeTruthy();
      // The new task is still going, with its way to stop it.
      expect(stop()).not.toBeNull();
    });

    it('a new task ends the one before: its step that waited can no longer be allowed', async () => {
      const { socket, onPerformAction } = openWithComputer();
      await proposed(socket);
      expect(allow().disabled).toBe(false);

      fireEvent.click(mode());
      say('Abre Chrome');
      await sentRequest(socket, 2);

      expect(allow().disabled).toBe(true);
      fireEvent.click(allow());
      await act(async () => {});
      expect(onPerformAction).not.toHaveBeenCalled();
    });

    it('never performs two actions at once', async () => {
      let finish: (jpeg: ArrayBuffer) => void = () => {};
      const { socket, onPerformAction } = openWithComputer(
        () => new Promise<ArrayBuffer>((resolve) => (finish = resolve)),
      );
      await proposed(socket);
      fireEvent.click(allow());
      await waitFor(() => expect(onPerformAction).toHaveBeenCalledTimes(1));

      // While the first is being performed, the menu bar stops the task and a new one starts.
      fireEvent.click(mode());
      say('Abre Chrome');
      await act(async () => {});
      expect(onPerformAction).toHaveBeenCalledTimes(1);

      await act(async () => finish(jpeg()));
      // The first task was ended by the second: its next step is not asked for.
      await waitFor(() => expect(socket.requests.length).toBeGreaterThanOrEqual(2));
      expect(
        socket.requests.filter((request) => 'done' in request && request.done.length > 0),
      ).toEqual([]);
    });

    it('keeps the app out of the way while it runs by itself, and brings it back to ask or to end', async () => {
      const { socket, onCaptureScreen, onPerformAction, onReveal } = openWithComputer();
      await routine(socket);
      const second = await sentRequest(socket, 2);

      expect(onCaptureScreen).toHaveBeenCalledWith(true);
      expect(onPerformAction).toHaveBeenCalledWith(CLICK, true);
      expect(onReveal).not.toHaveBeenCalled();

      act(() => socket.receive(replyTo(second.id, { text: 'Hecho.' })));
      expect(onReveal).toHaveBeenCalledTimes(1);
    });

    it('brings the app back when a step of care arrives', async () => {
      const { socket, onReveal } = openWithComputer();
      await proposed(socket);

      expect(onReveal).toHaveBeenCalledTimes(1);
    });

    it('brings the app back when the task could not even start', async () => {
      const { onReveal } = openWithComputer(
        async () => jpeg(),
        async () => {
          throw 'screen_permission';
        },
      );
      fireEvent.click(mode());
      say(task);

      await waitFor(() => expect(onReveal).toHaveBeenCalledTimes(1));
    });

    it('tells the shell while a task runs, and stops from the menu bar', async () => {
      const { socket, onPerformAction, onTaskRunning, onReveal, stopFromMenu } = openWithComputer();
      fireEvent.click(mode());
      say(task);
      const request = await sentRequest(socket);
      expect(onTaskRunning).toHaveBeenLastCalledWith(true);

      stopFromMenu();
      expect(onTaskRunning).toHaveBeenLastCalledWith(false);
      expect(onReveal).toHaveBeenCalledTimes(1);

      act(() => socket.receive(routineReply(request.id)));
      await act(async () => {});
      expect(onPerformAction).not.toHaveBeenCalled();
    });

    const lookAtScreen = () => screen.getByRole('button', { name: strings.chat.screen });

    it('takes no look at the screen while a task runs', async () => {
      const { socket, onCaptureScreen } = openWithComputer();
      fireEvent.click(mode());
      say(task);
      await sentRequest(socket);

      fireEvent.click(lookAtScreen());
      await act(async () => {});

      expect(onCaptureScreen).toHaveBeenCalledTimes(1);
      expect(screen.getByText(strings.chat.computerBusy)).toBeTruthy();
    });

    it('a look at the screen waits for an action still being performed', async () => {
      let finish: (jpeg: ArrayBuffer) => void = () => {};
      const { socket, onCaptureScreen, onPerformAction, stopFromMenu } = openWithComputer(
        () => new Promise<ArrayBuffer>((resolve) => (finish = resolve)),
      );
      await proposed(socket);
      fireEvent.click(allow());
      await waitFor(() => expect(onPerformAction).toHaveBeenCalledTimes(1));
      stopFromMenu();

      fireEvent.click(lookAtScreen());
      await act(async () => {});
      expect(onCaptureScreen).toHaveBeenCalledTimes(1);

      await act(async () => finish(jpeg()));
      await waitFor(() => expect(onCaptureScreen).toHaveBeenCalledTimes(2));
      expect(onCaptureScreen).toHaveBeenLastCalledWith();
    });

    it('stays out of the way when a new task follows a stop made during an action', async () => {
      let finish: (jpeg: ArrayBuffer) => void = () => {};
      const { socket, onPerformAction, onReveal, stopFromMenu } = openWithComputer(
        () => new Promise<ArrayBuffer>((resolve) => (finish = resolve)),
      );
      await proposed(socket);
      onReveal.mockClear();
      fireEvent.click(allow());
      await waitFor(() => expect(onPerformAction).toHaveBeenCalledTimes(1));
      stopFromMenu();
      fireEvent.click(mode());
      say('Abre Chrome');

      await act(async () => finish(jpeg()));
      await sentRequest(socket, 2);

      expect(onReveal).not.toHaveBeenCalled();
    });
  });
});
