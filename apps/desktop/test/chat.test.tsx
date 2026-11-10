// @vitest-environment jsdom
import type { ChatReply } from '@anomander/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { composer, emitSnapshot, renderApp, renderConnected } from './harness.tsx';
import { CHANNEL, running, stopped, TOKEN } from './snapshots.ts';

vi.mock('../src/shell.ts', async () => ({ shell: (await import('./shell-mock.ts')).shellMock }));

const S1 = '¡Hecho! He apuntado 23,00 € de la cena en restaurantes.';
const S19 = 'Esa pregunta ya no está abierta.';

const reply = (inReplyTo: string, overrides: Partial<ChatReply> = {}): ChatReply => ({
  type: 'reply',
  inReplyTo,
  channelRef: `desktop:${inReplyTo}`,
  text: S1,
  buttons: [],
  sentAt: '2026-11-10T20:00:00.000Z',
  ...overrides,
});

const type = (text: string) => fireEvent.change(composer(), { target: { value: text } });
const pressEnter = (shiftKey = false) => fireEvent.keyDown(composer(), { key: 'Enter', shiftKey });

/** Types a text, sends it with Enter and returns the id the request carried. */
const sendText = (socket: FakeWebSocket, text: string): string => {
  type(text);
  pressEnter();
  const request = socket.lastRequest();
  if (request.type !== 'text') throw new Error('expected a text request');
  return request.id;
};

const answer = (socket: FakeWebSocket, event: Parameters<FakeWebSocket['answer']>[0]) =>
  act(() => socket.answer(event));

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('chat (DK-4)', () => {
  it('connects with the token as a subprotocol and never shows it', async () => {
    await renderApp(running());

    const socket = FakeWebSocket.latest();
    expect(socket.url).toBe(CHANNEL.url);
    expect(socket.protocols).toEqual(['anomander.v1', TOKEN]);
    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
  });

  it('sends a text on Enter and shows it pending until its reply', async () => {
    const { socket } = await renderConnected(running());

    const id = sendText(socket, '23 € cena');

    expect(socket.lastRequest()).toEqual({ type: 'text', id, text: '23 € cena' });
    expect(composer().value).toBe('');
    expect(screen.getByText('23 € cena')).toBeTruthy();
    expect(screen.getByText(strings.sending)).toBeTruthy();
    answer(socket, reply(id));
    expect(screen.getByText(S1)).toBeTruthy();
    expect(screen.queryByText(strings.sending)).toBeNull();
  });

  it('keeps Shift+Enter as a new line instead of sending', async () => {
    const { socket } = await renderConnected(running());

    type('una línea');
    pressEnter(true);

    expect(socket.sent).toEqual([]);
  });

  it('does not send an empty text, nor one over 4096 characters', async () => {
    const { socket } = await renderConnected(running());

    type('   ');
    pressEnter();
    type('a'.repeat(4097));
    pressEnter();

    expect(socket.sent).toEqual([]);
    expect(screen.getByText(strings.tooLong(4097))).toBeTruthy();
  });

  it("renders a reply's text as plain text, line breaks kept, never as HTML", async () => {
    const { socket } = await renderConnected(running());
    const id = sendText(socket, 'hola');
    const text = '<b>Total</b>: 23,00 €\n<img src=x onerror=alert(1)>';

    answer(socket, reply(id, { text }));

    const bubble = screen.getByText((_, element) => element?.textContent === text, {
      selector: 'p',
    });
    expect(bubble.querySelector('b, img')).toBeNull();
    expect(bubble.textContent).toBe(text);
  });

  it('announces incoming replies through a live region', async () => {
    const { socket } = await renderConnected(running());
    const id = sendText(socket, 'hola');

    answer(socket, reply(id));

    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe(strings.newReply(S1));
  });

  it("sends a button press with the reply's channelRef and disables its buttons", async () => {
    const { socket } = await renderConnected(running());
    const id = sendText(socket, '23 € cena');
    answer(
      socket,
      reply(id, {
        text: '¿Lo apunto en restaurantes?',
        buttons: [
          { label: 'Sí', data: 'confirm:yes' },
          { label: 'No', data: 'confirm:no' },
        ],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sí' }));

    const press = socket.lastRequest();
    expect(press).toMatchObject({
      type: 'button',
      data: 'confirm:yes',
      channelRef: `desktop:${id}`,
    });
    expect(screen.getByRole('button', { name: /Sí/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'No' }).hasAttribute('disabled')).toBe(true);
    answer(socket, reply(press.id, { text: S19 }));
    expect(screen.getByText(S19)).toBeTruthy();
  });

  it('enables the buttons again when a press is not delivered', async () => {
    const { socket } = await renderConnected(running());
    const id = sendText(socket, '23 € cena');
    answer(socket, reply(id, { buttons: [{ label: 'Sí', data: 'confirm:yes' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Sí' }));

    answer(socket, { type: 'rejected', inReplyTo: socket.lastRequest().id });

    expect(screen.getByRole('button', { name: 'Sí' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(strings.pressNotSent)).toBeTruthy();
  });

  it('opens a URL button only when it is https', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { socket } = await renderConnected(running());
    const id = sendText(socket, 'conecta');
    answer(
      socket,
      reply(id, {
        buttons: [
          { label: 'Abrir', url: 'https://example.com/login' },
          { label: 'Inseguro', url: 'http://example.com' },
          { label: 'Script', url: 'javascript:alert(1)' },
        ],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inseguro' }));
    fireEvent.click(screen.getByRole('button', { name: 'Script' }));

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.com/login', '_blank', 'noopener,noreferrer');
    expect(socket.requests().filter((request) => request.type === 'button')).toEqual([]);
  });

  it('marks a rejected message as not sent and retries it with a new id', async () => {
    const { socket } = await renderConnected(running());
    const id = sendText(socket, '23 € cena');

    answer(socket, { type: 'rejected', inReplyTo: id });
    expect(screen.getByText(strings.notSent)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: strings.retry }));

    const retried = socket.lastRequest();
    expect(retried).toMatchObject({ type: 'text', text: '23 € cena' });
    expect(retried.id).not.toBe(id);
    expect(screen.queryByText(strings.notSent)).toBeNull();
    expect(screen.getAllByText('23 € cena')).toHaveLength(1);
  });

  it('marks a message as not sent when the connection drops mid-request', async () => {
    const { socket } = await renderConnected(running());
    sendText(socket, '23 € cena');

    act(() => socket.drop());

    expect(screen.getByText(strings.notSent)).toBeTruthy();
  });

  it('disables the composer, saying why, while there is no channel', async () => {
    await renderApp(stopped({ reason: 'stopped_by_principal' }));

    expect(composer().disabled).toBe(true);
    expect(screen.getByText(strings.noChannel.stopped)).toBeTruthy();
    expect(FakeWebSocket.instances).toEqual([]);
  });

  it('reconnects when the channel changes and closes the old socket', async () => {
    const { socket } = await renderConnected(running());

    emitSnapshot(running({ channel: { url: 'ws://127.0.0.1:50000', token: TOKEN } }));

    expect(socket.closedByClient).toBe(true);
    expect(FakeWebSocket.latest().url).toBe('ws://127.0.0.1:50000');
  });

  it('keeps the conversation when the daemon restarts', async () => {
    const { socket } = await renderConnected(running());
    const id = sendText(socket, '23 € cena');
    answer(socket, reply(id));

    emitSnapshot(stopped({ reason: 'stopped_by_principal' }));
    emitSnapshot(running({ channel: { url: 'ws://127.0.0.1:50000', token: TOKEN } }));

    expect(screen.getByText(S1)).toBeTruthy();
  });
});

describe('receipts (DK-4 AC2)', () => {
  const png = (name: string) =>
    new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

  it('sends picked images as one receipt with the text as caption, thumbnails shown', async () => {
    const { socket } = await renderConnected(running());

    fireEvent.change(screen.getByLabelText(strings.attach), {
      target: { files: [png('a.png'), png('b.png')] },
    });
    await screen.findAllByRole('img');
    type('cena del sábado');
    pressEnter();

    const request = socket.lastRequest();
    expect(request).toMatchObject({
      type: 'receipt',
      caption: 'cena del sábado',
      images: [
        { mimeType: 'image/png', data: 'iVBORw==' },
        { mimeType: 'image/png', data: 'iVBORw==' },
      ],
    });
    const log = screen.getByRole('list', { name: strings.conversation });
    expect(within(log).getAllByRole('img')).toHaveLength(2);
  });

  it('sends a receipt with no text with a null caption', async () => {
    const { socket } = await renderConnected(running());

    fireEvent.change(screen.getByLabelText(strings.attach), { target: { files: [png('a.png')] } });
    await screen.findAllByRole('img');
    fireEvent.click(screen.getByRole('button', { name: strings.send }));

    expect(socket.lastRequest()).toMatchObject({ type: 'receipt', caption: null });
  });

  it('takes images dropped on the window', async () => {
    const { socket } = await renderConnected(running());

    fireEvent.drop(screen.getByRole('main'), {
      dataTransfer: { files: [png('a.png')], types: ['Files'] },
    });
    await screen.findAllByRole('img');
    pressEnter();

    expect(socket.lastRequest()).toMatchObject({ type: 'receipt' });
  });

  it('keeps at most 10 images in one receipt', async () => {
    await renderConnected(running());
    const files = Array.from({ length: 12 }, (_, index) => png(`${index}.png`));

    fireEvent.change(screen.getByLabelText(strings.attach), { target: { files } });

    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(10));
    expect(screen.getByText(strings.tooManyImages)).toBeTruthy();
  });
});
