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

  it('says why Enter did nothing while the connection is not open yet (S5)', () => {
    renderChat();
    say('23 € cena');

    // The reason was already on screen; now it is announced, so the message was not dropped silently.
    expect(screen.getByRole('status').textContent).toBe(
      strings.chat.heldBack(strings.chat.disabled.connecting),
    );
    expect(composer().value).toBe('23 € cena');
  });

  it('keys the empty chat to the daemon: stopped offers to start it (S5)', () => {
    const onStart = vi.fn();
    render(
      <ChatScreen daemon={stopped('stopped_by_principal')} channel={null} onStart={onStart} />,
    );

    expect(screen.queryByText(strings.chat.emptyTitle)).toBeNull();
    expect(screen.getByText(strings.chat.emptyStopped.title)).toBeTruthy();
    expect(screen.getByText(strings.chat.emptyStopped.body)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: strings.chat.emptyStopped.action }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('keys the empty chat to the daemon: without a start action, stopped only says so (S5)', () => {
    renderChat(stopped(null, 'spawn node ENOENT'), null);

    expect(screen.getByText(strings.chat.emptyStopped.title)).toBeTruthy();
    expect(screen.queryByRole('button', { name: strings.chat.emptyStopped.action })).toBeNull();
  });

  it.each([
    [stopped('not_configured'), strings.chat.emptyNotConfigured],
    [STARTING, strings.chat.emptyStarting],
    [{ state: 'failing', reason: null, lastError: 'boom' } as const, strings.chat.emptyFailing],
  ])('keys the empty chat to the daemon: %j', (daemon, empty) => {
    renderChat(daemon, null);

    expect(screen.getByText(empty.title)).toBeTruthy();
    expect(screen.getByText(empty.body)).toBeTruthy();
    expect(screen.queryByText(strings.chat.emptyTitle)).toBeNull();
    expect(screen.queryByRole('button', { name: strings.chat.emptyStopped.action })).toBeNull();
  });

  it('shows the usual empty chat once the channel is there', () => {
    renderChat();
    expect(screen.getByText(strings.chat.emptyTitle)).toBeTruthy();
    expect(screen.queryByText(strings.chat.emptyStopped.title)).toBeNull();
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

const ROUTED = { screen: 'Miro tu pantalla.', computer: 'Me pongo con ello en tu ordenador.' };

/**
 * DK-13: says `task` as a plain text and has the daemon route it `to` a look or a task on the
 * computer, in its own words. Answers the text request.
 */
const routed = async (socket: FakeWebSocket, to: 'screen' | 'computer', task: string) => {
  const before = socket.requests.length;
  say(task);
  const request = await sentRequest(socket, before + 1);
  expect(request).toMatchObject({ type: 'text', text: task });
  act(() => socket.receive(replyTo(request.id, { text: ROUTED[to], route: { to, task } })));
  return request;
};

const jpeg = () => new TextEncoder().encode('bytes').buffer as ArrayBuffer;

describe('the composer (DK-13 AC3)', () => {
  it('offers no mode: only files and send, wherever the window can look and act', () => {
    render(
      <ChatScreen
        daemon={RUNNING}
        channel={CHANNEL}
        onCaptureScreen={async () => jpeg()}
        onPerformAction={async () => jpeg()}
      />,
    );
    act(() => FakeWebSocket.last.open());

    const form = composer().closest('form') as HTMLElement;
    expect(
      within(form)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([strings.chat.attach, strings.chat.send]);
    expect(composer().placeholder).toBe(strings.chat.placeholder);
  });

  it('names the model in use under where the principal writes, subtly (S2)', () => {
    render(<ChatScreen daemon={RUNNING} channel={CHANNEL} model="openai/gpt-4o-mini" />);

    const label = screen.getByText('openai/gpt-4o-mini');
    expect(label.classList.contains('composer-model')).toBe(true);
    expect(label.closest('form')).not.toBeNull();
    expect(label.closest('.composer-box')).toBeNull();
    expect(label.textContent).toBe(`${strings.chat.model} openai/gpt-4o-mini`);
  });

  it('names no model when there is none', () => {
    const { container } = render(<ChatScreen daemon={RUNNING} channel={CHANNEL} model={null} />);

    expect(container.querySelector('.composer-model')).toBeNull();
  });
});

describe('a look at the screen (DK-9, DK-13)', () => {
  const openWithScreen = (capture: () => Promise<ArrayBuffer> = async () => jpeg()) => {
    const onCaptureScreen = vi.fn(capture);
    render(<ChatScreen daemon={RUNNING} channel={CHANNEL} onCaptureScreen={onCaptureScreen} />);
    act(() => FakeWebSocket.last.open());
    return { socket: FakeWebSocket.last, onCaptureScreen };
  };
  const question = '¿De quién es este correo?';

  it('looks when the daemon routes the words to it: the capture is shown and sent with them', async () => {
    const { socket, onCaptureScreen } = openWithScreen();
    await routed(socket, 'screen', question);

    expect(await sentRequest(socket, 2)).toEqual({
      id: expect.any(String),
      type: 'screen',
      text: question,
      image: { mimeType: 'image/jpeg', data: BYTES },
    });
    // A look does not keep the app out of the way.
    expect(onCaptureScreen).toHaveBeenCalledTimes(1);
    expect(onCaptureScreen).toHaveBeenCalledWith();
    const log = screen.getByRole('log');
    expect(within(log).getByRole('img', { name: strings.chat.screenCapture })).toBeTruthy();
    expect(within(log).getByText(ROUTED.screen)).toBeTruthy();
    // The principal's words are shown once, as they wrote them.
    expect(within(log).getAllByText(question)).toHaveLength(1);
  });

  it('lets go of the capture when the chat leaves the screen', async () => {
    const { socket } = openWithScreen();
    await routed(socket, 'screen', question);
    await sentRequest(socket, 2);
    const capture = within(screen.getByRole('log')).getByRole<HTMLImageElement>('img', {
      name: strings.chat.screenCapture,
    });

    cleanup();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(capture.getAttribute('src'));
  });

  it('waits for the answer about the screen, and shows it', async () => {
    const { socket } = openWithScreen();
    await routed(socket, 'screen', question);
    const look = await sentRequest(socket, 2);

    expect(screen.getByText(strings.chat.thinking)).toBeTruthy();
    act(() => socket.receive(replyTo(look.id, { text: 'Es de Ana, sobre la reunión.' })));

    expect(screen.getByText('Es de Ana, sobre la reunión.')).toBeTruthy();
    expect(screen.queryByText(strings.chat.thinking)).toBeNull();
  });

  it('says it cannot look where the window cannot capture the screen', async () => {
    const socket = openChat();
    await routed(socket, 'screen', question);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.screenUnavailable),
    );
    expect(socket.requests).toHaveLength(1);
    expect(screen.queryByText(strings.chat.thinking)).toBeNull();
  });

  it('says how to allow it when macOS does not let the app see the screen, and looks again when asked', async () => {
    let allowedByMac = false;
    const { socket, onCaptureScreen } = openWithScreen(async () => {
      if (!allowedByMac) throw 'screen_permission';
      return jpeg();
    });
    await routed(socket, 'screen', question);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.screenPermission),
    );
    expect(screen.getByText(strings.chat.lookNotSent)).toBeTruthy();
    expect(socket.requests).toHaveLength(1);

    allowedByMac = true;
    fireEvent.click(screen.getByRole('button', { name: strings.chat.startAgain }));

    // Still a look, never a plain text.
    expect(await sentRequest(socket, 2)).toMatchObject({ type: 'screen', text: question });
    expect(onCaptureScreen).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(strings.chat.lookNotSent)).toBeNull();
  });

  it('says when the capture failed for another reason', async () => {
    const { socket } = openWithScreen(async () => {
      throw 'screencapture exited with 1';
    });
    await routed(socket, 'screen', question);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.screenFailed),
    );
    expect(socket.requests).toHaveLength(1);
  });

  it('says a look was not sent when the daemon rejects it, and offers it again', async () => {
    const { socket } = openWithScreen();
    await routed(socket, 'screen', question);
    const look = await sentRequest(socket, 2);
    act(() => socket.receive({ type: 'rejected', inReplyTo: look.id }));

    expect(screen.getByText(strings.chat.lookNotSent)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: strings.chat.startAgain }));
    expect(await sentRequest(socket, 3)).toMatchObject({ type: 'screen', text: question });
  });

  it('offers nothing again when the connection was lost during a look', async () => {
    const { socket } = openWithScreen();
    await routed(socket, 'screen', question);
    await sentRequest(socket, 2);
    act(() => socket.drop());

    expect(screen.getByText(strings.chat.startUnknown)).toBeTruthy();
    expect(screen.queryByRole('button', { name: strings.chat.startAgain })).toBeNull();
  });

  it.each([
    [
      'a receipt',
      () => fireEvent.paste(composer(), { clipboardData: { files: [image('ticket.png')] } }),
    ],
    ['a press', () => fireEvent.click(screen.getByRole('button', { name: 'Sí' }))],
  ])('ignores a route in the reply to %s: only a plain text is routed', async (_, send) => {
    const { socket, onCaptureScreen } = openWithScreen();
    say('mercadona 40');
    const text = await sentRequest(socket);
    act(() =>
      socket.receive(replyTo(text.id, { buttons: [{ label: 'Sí', data: 'policy:yes:7' }] })),
    );
    send();
    if (socket.requests.length === 1) pressEnter();
    const request = await sentRequest(socket, 2);
    act(() =>
      socket.receive(
        replyTo(request.id, { text: ROUTED.screen, route: { to: 'screen', task: 'mira' } }),
      ),
    );
    await act(async () => {});

    expect(onCaptureScreen).not.toHaveBeenCalled();
    expect(socket.requests).toHaveLength(2);
    expect(screen.queryByText(strings.chat.thinking)).toBeNull();
  });
});

describe('a task on the computer (DK-10, DK-13)', () => {
  const CLICK = { kind: 'click', x: 512, y: 80, double: false, target: 'Enviar' } as const;
  const PROPOSAL = 'Quiero hacer clic en «Enviar».';
  const task = 'Envía el correo que tengo abierto';

  const openWithComputer = (
    perform: (action: unknown, ...rest: unknown[]) => Promise<ArrayBuffer> = async () => jpeg(),
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
  const allow = () =>
    screen.getByRole<HTMLButtonElement>('button', { name: strings.chat.computerAllow });
  const refuse = () =>
    screen.getByRole<HTMLButtonElement>('button', { name: strings.chat.computerRefuse });
  /** Has the daemon route `text` to a task on the computer; answers the task's first step. */
  const started = async (socket: FakeWebSocket, text = task) => {
    const before = socket.requests.length;
    await routed(socket, 'computer', text);
    return sentRequest(socket, before + 2);
  };
  /** Asks for the task and has the daemon propose `computer` for it. */
  const proposed = async (socket: FakeWebSocket, computer: unknown = CLICK, text = PROPOSAL) => {
    const request = await started(socket);
    act(() => socket.receive(replyTo(request.id, { text, computer } as never)));
    return request;
  };

  it('says it cannot act where the window cannot perform an action', async () => {
    const socket = openChat();
    await routed(socket, 'computer', task);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.computerUnavailable),
    );
    expect(socket.requests).toHaveLength(1);
    expect(screen.queryByText(strings.chat.thinking)).toBeNull();
  });

  it('starts the task the daemon routes, with the screen as it is, and performs nothing', async () => {
    const { socket, onCaptureScreen, onPerformAction } = openWithComputer();
    await routed(socket, 'computer', task);

    expect(await sentRequest(socket, 2)).toEqual({
      id: expect.any(String),
      type: 'computer',
      task,
      image: { mimeType: 'image/jpeg', data: BYTES },
      done: [],
    });
    expect(onCaptureScreen).toHaveBeenCalledTimes(1);
    expect(onCaptureScreen).toHaveBeenCalledWith(true);
    expect(onPerformAction).not.toHaveBeenCalled();
    const log = screen.getByRole('log');
    expect(within(log).getByText(ROUTED.computer)).toBeTruthy();
    // The principal's words are shown once, as they wrote them.
    expect(within(log).getAllByText(task)).toHaveLength(1);
    expect(screen.getByText(strings.chat.thinking)).toBeTruthy();
  });

  it('AC1: shows the proposed action and waits; allowing it performs exactly that action and asks for the next step', async () => {
    const { socket, onPerformAction } = openWithComputer();
    await proposed(socket);

    expect(screen.getByText(PROPOSAL)).toBeTruthy();
    expect(screen.getByRole('img', { name: strings.chat.computerPreview })).toBeTruthy();
    expect(onPerformAction).not.toHaveBeenCalled();
    expect(socket.requests).toHaveLength(2);
    expect(screen.queryByText(strings.chat.thinking)).toBeNull();

    fireEvent.click(allow());

    expect(await sentRequest(socket, 3)).toMatchObject({
      type: 'computer',
      task,
      image: { mimeType: 'image/jpeg', data: BYTES },
      done: [PROPOSAL],
    });
    expect(onPerformAction).toHaveBeenCalledTimes(1);
    expect(onPerformAction).toHaveBeenCalledWith(CLICK, true, true);
    expect(allow().disabled).toBe(true);
    expect(refuse().disabled).toBe(true);
  });

  it('carries every step done so far to the next one', async () => {
    const { socket } = openWithComputer();
    await proposed(socket);
    fireEvent.click(allow());
    const second = await sentRequest(socket, 3);
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

    expect(await sentRequest(socket, 4)).toMatchObject({
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
    expect(socket.requests).toHaveLength(2);
  });

  it('performs an allowed action once, however many times it is pressed', async () => {
    const { socket, onPerformAction } = openWithComputer();
    await proposed(socket);

    fireEvent.click(allow());
    fireEvent.click(allow());
    await sentRequest(socket, 3);

    expect(onPerformAction).toHaveBeenCalledTimes(1);
  });

  it('shows no buttons when the daemon ends the task in words', async () => {
    const { socket } = openWithComputer();
    const request = await started(socket);
    act(() => socket.receive(replyTo(request.id, { text: 'Correo enviado.' })));

    expect(screen.getByText('Correo enviado.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: strings.chat.computerAllow })).toBeNull();
    expect(screen.queryByText(strings.chat.thinking)).toBeNull();
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

  it('ignores a route in the answer to a step: only a plain text is routed', async () => {
    const { socket, onCaptureScreen } = openWithComputer();
    const request = await started(socket);
    act(() =>
      socket.receive(
        replyTo(request.id, { text: ROUTED.screen, route: { to: 'screen', task: 'mira' } }),
      ),
    );
    await act(async () => {});

    expect(onCaptureScreen).toHaveBeenCalledTimes(1);
    expect(socket.requests).toHaveLength(2);
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
    expect(socket.requests).toHaveLength(2);
  });

  it('does not offer the action again when it may have been done', async () => {
    const { socket } = openWithComputer(async () => {
      throw 'the capture failed: exit status: 1';
    });
    await proposed(socket);

    fireEvent.click(allow());

    await waitFor(() => expect(screen.getByText(strings.chat.computerUnknown)).toBeTruthy());
    expect(allow().disabled).toBe(true);
    expect(socket.requests).toHaveLength(2);
  });

  it('does not offer the action again when the connection was lost after doing it', async () => {
    const { socket } = openWithComputer();
    await proposed(socket);
    fireEvent.click(allow());
    await sentRequest(socket, 3);

    act(() => socket.drop());

    expect(screen.getByText(strings.chat.computerUnknown)).toBeTruthy();
    expect(allow().disabled).toBe(true);
  });

  it('a task that could not capture the screen was not sent, and starts again as a task', async () => {
    let allowedByMac = false;
    const { socket } = openWithComputer(
      async () => jpeg(),
      async () => {
        if (!allowedByMac) throw 'screen_permission';
        return jpeg();
      },
    );
    await routed(socket, 'computer', task);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.chat.screenPermission),
    );
    expect(screen.getByText(strings.chat.taskNotSent)).toBeTruthy();
    expect(socket.requests).toHaveLength(1);

    allowedByMac = true;
    fireEvent.click(screen.getByRole('button', { name: strings.chat.startAgain }));

    // Never as a plain text: with the screen as it is now.
    expect(await sentRequest(socket, 2)).toMatchObject({ type: 'computer', task, done: [] });
    expect(screen.queryByText(strings.chat.taskNotSent)).toBeNull();
  });

  describe('a routine step', () => {
    const stop = () => screen.queryByRole('button', { name: strings.chat.computerStop });
    /** Asks for the task; the daemon answers `computer` as a routine step. */
    const routine = async (socket: FakeWebSocket) => {
      const request = await started(socket);
      act(() =>
        socket.receive(
          replyTo(request.id, { text: PROPOSAL, computer: CLICK, confirm: false } as never),
        ),
      );
    };

    it('is performed without asking, shown as it is, and the task goes on', async () => {
      const { socket, onPerformAction } = openWithComputer();
      await routine(socket);

      expect(await sentRequest(socket, 3)).toMatchObject({ type: 'computer', done: [PROPOSAL] });
      expect(onPerformAction).toHaveBeenCalledTimes(1);
      expect(onPerformAction).toHaveBeenCalledWith(CLICK, true, false);
      expect(screen.getByText(PROPOSAL)).toBeTruthy();
      expect(screen.getByText(strings.chat.computerAuto)).toBeTruthy();
      expect(screen.queryByRole('button', { name: strings.chat.computerAllow })).toBeNull();
    });

    it('is asked for all the same unless the daemon says it is routine', async () => {
      const { socket, onPerformAction } = openWithComputer();
      const request = await started(socket);
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
      const second = await sentRequest(socket, 3);
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
      const third = await sentRequest(socket, 4);
      expect(stop()).not.toBeNull();
      act(() => socket.receive(replyTo(third.id, { text: 'Hecho.' })));
      expect(stop()).toBeNull();
    });

    it('stopping the task performs nothing more, even a routine step already on its way', async () => {
      const { socket, onPerformAction } = openWithComputer();
      const request = await started(socket);

      fireEvent.click(stop() as HTMLElement);
      act(() =>
        socket.receive(
          replyTo(request.id, { text: PROPOSAL, computer: CLICK, confirm: false } as never),
        ),
      );
      await act(async () => {});

      expect(onPerformAction).not.toHaveBeenCalled();
      expect(screen.getByText(strings.chat.computerRefused)).toBeTruthy();
      expect(socket.requests).toHaveLength(2);
      expect(stop()).toBeNull();
    });

    const routineReply = (id: string, text = PROPOSAL) =>
      replyTo(id, { text, computer: CLICK, confirm: false } as never);

    it('a new task runs again after one was stopped', async () => {
      const { socket, onPerformAction } = openWithComputer();
      await started(socket);
      fireEvent.click(stop() as HTMLElement);

      const again = await started(socket, 'Abre Chrome');
      expect(again).toMatchObject({ type: 'computer', task: 'Abre Chrome' });
      act(() => socket.receive(routineReply(again.id)));

      await sentRequest(socket, 5);
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
      expect(socket.requests).toHaveLength(2);
      expect(stop()).toBeNull();

      allowedByMac = true;
      fireEvent.click(allow());
      await sentRequest(socket, 3);
      expect(onPerformAction).toHaveBeenCalledTimes(2);
    });

    it('asks for permission when the shell sees a step of care on the screen', async () => {
      // T1b: the daemon called it routine; the shell read a Send button under the point.
      let permitted = false;
      const { socket, onPerformAction, onReveal } = openWithComputer(async (...args) => {
        permitted = args[2] === true;
        if (!permitted) throw 'computer_careful';
        return jpeg();
      });
      await routine(socket);

      await waitFor(() => expect(allow().disabled).toBe(false));
      expect(onPerformAction).toHaveBeenCalledWith(CLICK, true, false);
      expect(socket.requests).toHaveLength(2);
      expect(stop()).toBeNull();
      expect(onReveal).toHaveBeenCalled();
      expect(screen.queryByText(strings.chat.computerAuto)).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();

      fireEvent.click(allow());
      expect(await sentRequest(socket, 3)).toMatchObject({ type: 'computer', done: [PROPOSAL] });
      expect(onPerformAction).toHaveBeenLastCalledWith(CLICK, true, true);
      expect(permitted).toBe(true);
    });

    it('shows what the shell read on the screen instead of what the daemon said is there', async () => {
      // The daemon called the control "Enviar"; the shell read a button named "Pagar ahora".
      const { socket } = openWithComputer(async (...args) => {
        if (args[2] !== true) throw 'computer_careful:AXButton:Pagar ahora';
        return jpeg();
      });
      await routine(socket);

      await waitFor(() => expect(allow().disabled).toBe(false));
      expect(screen.getByText('Quiero hacer clic en «Pagar ahora».')).toBeTruthy();
      expect(screen.queryByText(PROPOSAL)).toBeNull();
    });

    it('says which field Enter would act on when the shell asks for it', async () => {
      const { socket } = openWithComputer(async (...args) => {
        if (args[2] !== true) throw 'computer_careful:AXTextArea:Escribe un mensaje';
        return jpeg();
      });
      const request = await started(socket);
      const enter = { kind: 'key', key: 'enter', modifiers: [] };
      act(() =>
        socket.receive(
          replyTo(request.id, {
            text: 'Quiero pulsar Intro.',
            computer: enter,
            confirm: false,
          } as never),
        ),
      );

      await waitFor(() => expect(allow().disabled).toBe(false));
      expect(screen.getByText('Quiero pulsar Intro.')).toBeTruthy();
      expect(
        screen.getByText(strings.chat.computerSeen('campo', 'Escribe un mensaje')),
      ).toBeTruthy();
    });

    it('stops the task when the step targets an app ANOMANDER never acts on', async () => {
      const { socket, onPerformAction } = openWithComputer(async () => {
        throw 'computer_blocked:Ajustes del Sistema';
      });
      await routine(socket);

      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe(
          strings.chat.computerBlocked('Ajustes del Sistema'),
        ),
      );
      expect(onPerformAction).toHaveBeenCalledTimes(1);
      expect(screen.getByText(strings.chat.computerRefused)).toBeTruthy();
      expect(screen.queryByRole('button', { name: strings.chat.computerAllow })).toBeNull();
      expect(socket.requests).toHaveLength(2);
      expect(stop()).toBeNull();
    });

    it('a stopped task stays stopped when another one starts', async () => {
      const { socket, onPerformAction } = openWithComputer();
      const first = await started(socket);
      fireEvent.click(stop() as HTMLElement);
      await started(socket, 'Abre Chrome');

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

      await started(socket, 'Abre Chrome');

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

      // While the first is being performed, a new one starts.
      await routed(socket, 'computer', 'Abre Chrome');
      await act(async () => {});
      expect(onPerformAction).toHaveBeenCalledTimes(1);

      await act(async () => finish(jpeg()));
      // The first task was ended by the second: its next step is not asked for.
      await sentRequest(socket, 4);
      expect(
        socket.requests.filter((request) => 'done' in request && request.done.length > 0),
      ).toEqual([]);
    });

    it('keeps the app out of the way while it runs by itself, and brings it back to ask or to end', async () => {
      const { socket, onCaptureScreen, onPerformAction, onReveal } = openWithComputer();
      await routine(socket);
      const second = await sentRequest(socket, 3);

      expect(onCaptureScreen).toHaveBeenCalledWith(true);
      expect(onPerformAction).toHaveBeenCalledWith(CLICK, true, false);
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
      const { socket, onReveal } = openWithComputer(
        async () => jpeg(),
        async () => {
          throw 'screen_permission';
        },
      );
      await routed(socket, 'computer', task);

      await waitFor(() => expect(onReveal).toHaveBeenCalledTimes(1));
    });

    it('tells the shell while a task runs, and stops from the menu bar', async () => {
      const { socket, onPerformAction, onTaskRunning, onReveal, stopFromMenu } = openWithComputer();
      const request = await started(socket);
      expect(onTaskRunning).toHaveBeenLastCalledWith(true);

      stopFromMenu();
      expect(onTaskRunning).toHaveBeenLastCalledWith(false);
      expect(onReveal).toHaveBeenCalledTimes(1);

      act(() => socket.receive(routineReply(request.id)));
      await act(async () => {});
      expect(onPerformAction).not.toHaveBeenCalled();
    });

    it('takes no look at the screen while a task runs', async () => {
      const { socket, onCaptureScreen } = openWithComputer();
      await started(socket);

      await routed(socket, 'screen', '¿Qué ves?');
      await act(async () => {});

      expect(onCaptureScreen).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status').textContent).toBe(strings.chat.computerBusy);
      expect(screen.getByText(strings.chat.lookNotSent)).toBeTruthy();
      expect(socket.requests).toHaveLength(3);
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

      await routed(socket, 'screen', '¿Qué ves?');
      await act(async () => {});
      expect(onCaptureScreen).toHaveBeenCalledTimes(1);

      await act(async () => finish(jpeg()));
      await waitFor(() => expect(onCaptureScreen).toHaveBeenCalledTimes(2));
      expect(onCaptureScreen).toHaveBeenLastCalledWith();
      expect(await sentRequest(socket, 4)).toMatchObject({ type: 'screen', text: '¿Qué ves?' });
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
      await routed(socket, 'computer', 'Abre Chrome');

      await act(async () => finish(jpeg()));
      await sentRequest(socket, 4);

      expect(onReveal).not.toHaveBeenCalled();
    });
  });
});

describe('a task with connections (DK-11, DK-13)', () => {
  const task = 'Apunta en mis notas el hotel de Lisboa';

  it('is asked in words: it goes as a plain text, and the daemon runs it', async () => {
    const socket = openChat();
    say(task);

    expect(await sentRequest(socket)).toEqual({ id: expect.any(String), type: 'text', text: task });
  });

  it('answers a call that waits with its buttons, as any other question', async () => {
    const socket = openChat();
    say(task);
    const request = await sentRequest(socket);
    act(() =>
      socket.receive(
        replyTo(request.id, {
          text: 'Quiero usar «create» de «notes» con:\n{\n  "title": "Hotel Sol"\n}',
          buttons: [
            { label: 'Permitir', data: 'connection:abc:allow' },
            { label: 'Detener', data: 'connection:abc:refuse' },
          ],
        }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Permitir' }));

    expect(await sentRequest(socket, 2)).toMatchObject({
      type: 'button',
      data: 'connection:abc:allow',
    });
  });
});

describe('DK-13: a route is followed only in the answer to a plain text', () => {
  const openFull = () => {
    const onCaptureScreen = vi.fn(async () => jpeg());
    const onPerformAction = vi.fn(async () => jpeg());
    render(
      <ChatScreen
        daemon={RUNNING}
        channel={CHANNEL}
        onCaptureScreen={onCaptureScreen}
        onPerformAction={onPerformAction}
      />,
    );
    act(() => FakeWebSocket.last.open());
    return { socket: FakeWebSocket.last, onCaptureScreen, onPerformAction };
  };

  it('ignores a route in the answer to a button press', async () => {
    const { socket, onCaptureScreen } = openFull();
    say('mercadona 40');
    const request = await sentRequest(socket);
    act(() =>
      socket.receive(
        replyTo(request.id, { text: '¿Sí?', buttons: [{ label: 'Sí', data: 'policy:yes:7' }] }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sí' }));
    const pressed = await sentRequest(socket, 2);
    act(() =>
      socket.receive(replyTo(pressed.id, { text: 'x', route: { to: 'computer', task: 'abre' } })),
    );
    await act(async () => {});
    expect(onCaptureScreen).not.toHaveBeenCalled();
    expect(socket.requests).toHaveLength(2);
  });

  it('ignores a route in the answer to a receipt', async () => {
    const { socket, onCaptureScreen } = openFull();
    fireEvent.change(screen.getByLabelText(strings.chat.attach, { selector: 'input' }), {
      target: { files: [image('ticket.png')] },
    });
    pressEnter();
    const request = await sentRequest(socket);
    act(() =>
      socket.receive(replyTo(request.id, { text: 'x', route: { to: 'screen', task: 'mira' } })),
    );
    await act(async () => {});
    expect(onCaptureScreen).not.toHaveBeenCalled();
    expect(socket.requests).toHaveLength(1);
  });

  it('ignores a route in the answer to a look: no loop of captures', async () => {
    const { socket, onCaptureScreen } = openFull();
    await routed(socket, 'screen', '¿qué ves?');
    const look = await sentRequest(socket, 2);
    act(() =>
      socket.receive(replyTo(look.id, { text: 'x', route: { to: 'screen', task: 'otra' } })),
    );
    await act(async () => {});
    expect(onCaptureScreen).toHaveBeenCalledTimes(1);
    expect(socket.requests).toHaveLength(2);
  });

  it('ignores a connect route, and a second reply to the same text', async () => {
    const { socket, onCaptureScreen } = openFull();
    say('hola');
    const request = await sentRequest(socket);
    act(() =>
      socket.receive(
        replyTo(request.id, { text: 'a', route: { to: 'connect', task: 'x' } } as never),
      ),
    );
    act(() =>
      socket.receive(replyTo(request.id, { text: 'b', route: { to: 'screen', task: 'x' } })),
    );
    await act(async () => {});
    expect(onCaptureScreen).not.toHaveBeenCalled();
    expect(socket.requests).toHaveLength(1);
  });

  it('a reply to a text that arrives after the connection was opened again starts nothing', async () => {
    const { socket, onCaptureScreen } = openFull();
    say('hola');
    const request = await sentRequest(socket);
    act(() => socket.drop());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    const reopened = FakeWebSocket.last;
    act(() => reopened.open());
    act(() =>
      reopened.receive(replyTo(request.id, { text: 'late', route: { to: 'screen', task: 'x' } })),
    );
    await act(async () => {});
    expect(onCaptureScreen).not.toHaveBeenCalled();
  });

  it('a routed task still waits for Permitir before a step of care (DK-10 AC1)', async () => {
    const { socket, onPerformAction } = openFull();
    await routed(socket, 'computer', 'borra el archivo');
    const step = await sentRequest(socket, 2);
    act(() =>
      socket.receive(
        replyTo(step.id, {
          text: 'Pulso Borrar',
          computer: { type: 'click', x: 1, y: 1 } as never,
          confirm: true,
        }),
      ),
    );
    await act(async () => {});
    expect(onPerformAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /permitir/i })).toBeTruthy();
  });
});

describe('a missing web search (DK-11 AC13)', () => {
  const ASKED = 'Búscame dónde comprar una silla';
  const BACK: LocalChannel = { url: 'ws://127.0.0.1:4999', token: TOKEN };
  const missing = (inReplyTo: string) =>
    replyTo(inReplyTo, { text: 'Falta la búsqueda web.', offer: 'web_search' });
  const addButton = () => screen.getByRole('button', { name: strings.chat.addWebSearch });

  /** A chat that asked for a search and was told the web search is missing. */
  const toldMissing = async (add: () => Promise<boolean>) => {
    const onAddWebSearch = vi.fn(add);
    const chat = (daemon: DaemonStatus, channel: LocalChannel | null) => (
      <ChatScreen daemon={daemon} channel={channel} onAddWebSearch={onAddWebSearch} />
    );
    const view = render(chat(RUNNING, CHANNEL));
    const first = FakeWebSocket.last;
    act(() => first.open());
    say(ASKED);
    const request = await sentRequest(first);
    act(() => first.receive(missing(request.id)));
    return {
      first,
      onAddWebSearch,
      rerender: (...args: Parameters<typeof chat>) => view.rerender(chat(...args)),
    };
  };

  it('offers to add it, saying what leaves the Mac', async () => {
    await toldMissing(async () => true);

    expect(screen.getByText('Falta la búsqueda web.')).toBeTruthy();
    expect(screen.getByText(strings.connections.webSearchNote)).toBeTruthy();
    expect(addButton()).toBeTruthy();
  });

  it('adds it once pressed and asks again only once the daemon is back', async () => {
    let added: (value: boolean) => void = () => {};
    const { first, onAddWebSearch, rerender } = await toldMissing(
      () => new Promise((resolve) => (added = resolve)),
    );
    fireEvent.click(addButton());

    expect(onAddWebSearch).toHaveBeenCalledOnce();
    expect(addButton().hasAttribute('disabled')).toBe(true);
    // Saved while the old daemon still answers: nothing is asked of it.
    await act(async () => added(true));
    expect(first.requests).toHaveLength(1);
    // The daemon starts again to read the connection.
    rerender(STARTING, null);
    rerender(RUNNING, BACK);
    act(() => FakeWebSocket.last.open());

    expect(await sentRequest(FakeWebSocket.last)).toMatchObject({ type: 'text', text: ASKED });
    expect(screen.getAllByText(ASKED)).toHaveLength(2);
    expect(screen.getByText(strings.chat.webSearchAdded)).toBeTruthy();
    expect(screen.queryByRole('button', { name: strings.chat.addWebSearch })).toBeNull();
  });

  it('asks again at once when the web search was already there', async () => {
    const { first } = await toldMissing(async () => false);
    fireEvent.click(addButton());

    expect(await sentRequest(first, 2)).toMatchObject({ type: 'text', text: ASKED });
  });

  it('says when it could not be added, and can be pressed again', async () => {
    const { first, onAddWebSearch } = await toldMissing(async () => {
      throw new Error('mcp.json is not valid JSON');
    });
    fireEvent.click(addButton());

    expect(await screen.findByText(strings.chat.webSearchFailed)).toBeTruthy();
    expect(first.requests).toHaveLength(1);
    fireEvent.click(addButton());
    await waitFor(() => expect(onAddWebSearch).toHaveBeenCalledTimes(2));
  });

  /** A chat that asked `Q1` and `Q2` and was told twice the web search is missing. */
  const toldMissingTwice = async (add: () => Promise<boolean>) => {
    const chat = (daemon: DaemonStatus, channel: LocalChannel | null) => (
      <ChatScreen daemon={daemon} channel={channel} onAddWebSearch={add} />
    );
    const view = render(chat(RUNNING, CHANNEL));
    const first = FakeWebSocket.last;
    act(() => first.open());
    for (const [index, text] of ['Q1', 'Q2'].entries()) {
      say(text);
      const request = await sentRequest(first, index + 1);
      act(() => first.receive(missing(request.id)));
    }
    const [press1, press2] = screen
      .getAllByRole('button', { name: strings.chat.addWebSearch })
      .map((button) => () => fireEvent.click(button));
    return {
      press1: press1 ?? (() => {}),
      press2: press2 ?? (() => {}),
      rerender: (...args: Parameters<typeof chat>) => view.rerender(chat(...args)),
    };
  };
  const askedOnceBack = async () => {
    const back = FakeWebSocket.last;
    act(() => back.open());
    await waitFor(() => expect(back.requests).toHaveLength(2));
    return back.requests.map((request) => (request as { text: string }).text).sort();
  };

  it('asks a second offer again only once the daemon restarted for the first is back', async () => {
    let saves = 0;
    let added: (value: boolean) => void = () => {};
    // As `addWebSearch`: the first press saves; a later one finds the server already there.
    const { press1, press2, rerender } = await toldMissingTwice(() => {
      saves += 1;
      return saves === 1 ? new Promise((resolve) => (added = resolve)) : Promise.resolve(false);
    });
    const first = FakeWebSocket.last;
    press1();
    await act(async () => added(true));
    rerender(STARTING, null);
    press2();
    await act(async () => {});
    rerender(RUNNING, BACK);

    expect(first.requests).toHaveLength(2);
    expect(await askedOnceBack()).toEqual(['Q1', 'Q2']);
  });

  it('asks both again when two presses saved before the daemon restarted', async () => {
    const saved: ((value: boolean) => void)[] = [];
    const { press1, press2, rerender } = await toldMissingTwice(
      () => new Promise((resolve) => saved.push(resolve)),
    );
    press1();
    press2();
    await act(async () => {
      for (const resolve of saved) resolve(true);
    });
    rerender(STARTING, null);
    rerender(RUNNING, BACK);

    expect(await askedOnceBack()).toEqual(['Q1', 'Q2']);
  });

  it('offers nothing where the window cannot add a connection', async () => {
    const socket = openChat();
    say(ASKED);
    const request = await sentRequest(socket);
    act(() => socket.receive(missing(request.id)));

    expect(screen.getByText('Falta la búsqueda web.')).toBeTruthy();
    expect(screen.queryByText(strings.connections.webSearchNote)).toBeNull();
  });
});
