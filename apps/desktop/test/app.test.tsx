// @vitest-environment jsdom
import {
  formatAmount,
  formatDate,
  LOCAL_CHANNEL_PROTOCOL,
  strings as replies,
} from '@anomander/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { type LoginOutcome, type LoginStep, type Snapshot, shell } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import {
  CHANNEL,
  CONNECTIONS,
  EMPTY_SETUP,
  FILLED_SETUP,
  NO_CONNECTIONS,
  replyTo,
  runningSnapshot,
  STARTING,
  stoppedSnapshot,
  TOKEN,
} from './fixtures.ts';

// The whole window against a mocked shell: never real Tauri.
vi.mock('../src/shell.ts', () => ({
  shell: {
    snapshot: vi.fn(),
    saveSetup: vi.fn(),
    connections: vi.fn(),
    saveConnection: vi.fn(),
    removeConnection: vi.fn(),
    importLedger: vi.fn(),
    subscriptions: vi.fn(),
    connectSubscription: vi.fn(),
    answerLogin: vi.fn(),
    disconnectSubscription: vi.fn(),
    onLoginStep: vi.fn(),
    startDaemon: vi.fn(),
    stopDaemon: vi.fn(),
    onSnapshot: vi.fn(),
    setThinking: vi.fn(),
    notifyReply: vi.fn(),
    captureScreen: vi.fn(),
    performAction: vi.fn(),
    reveal: vi.fn(),
    openLink: vi.fn(),
    setTaskRunning: vi.fn(),
    onStopTask: vi.fn(),
    onChatShown: vi.fn(),
  },
}));

const mocked = vi.mocked(shell);
/** Sends the window a snapshot, as the shell's event does. */
let emit: (snapshot: Snapshot) => void;
let unlisten: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  unlisten = vi.fn();
  emit = () => {
    throw new Error('the window is not listening to the shell');
  };
  mocked.onSnapshot.mockImplementation(async (handler) => {
    emit = (snapshot) => act(() => handler(snapshot));
    return unlisten;
  });
  mocked.startDaemon.mockResolvedValue(undefined);
  mocked.stopDaemon.mockResolvedValue(undefined);
  mocked.setThinking.mockResolvedValue(undefined);
  mocked.notifyReply.mockResolvedValue(undefined);
  mocked.reveal.mockResolvedValue(undefined);
  mocked.openLink.mockResolvedValue(undefined);
  mocked.setTaskRunning.mockResolvedValue(undefined);
  mocked.onStopTask.mockResolvedValue(() => {});
  mocked.onChatShown.mockResolvedValue(() => {});
  mocked.onLoginStep.mockResolvedValue(() => {});
  mocked.connections.mockResolvedValue(NO_CONNECTIONS);
  mocked.saveConnection.mockResolvedValue(NO_CONNECTIONS);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const open = async (snapshot: Snapshot) => {
  mocked.snapshot.mockResolvedValue(snapshot);
  const view = render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).not.toBe(strings.status.loading),
  );
  // The status is on screen before the effects of that render ran: let them (the chat connects,
  // the setup opens by itself).
  await act(async () => {});
  return view;
};

const setupHeading = () => screen.queryByRole('heading', { name: strings.setup.title });
const composer = (): HTMLTextAreaElement => screen.getByLabelText(strings.chat.message);

describe('opening', () => {
  it('shows the daemon running and connects the chat with the channel of the shell', async () => {
    await open(runningSnapshot());

    expect(screen.getByRole('status').textContent).toBe(strings.status.running);
    expect(FakeWebSocket.last.url).toBe('ws://127.0.0.1:4312');
    expect(FakeWebSocket.last.protocols.at(1)).toBe(TOKEN);
    expect(setupHeading()).toBeNull();
  });

  it('opens a web address of a reply, and a link button, through the shell (B25)', async () => {
    await open(runningSnapshot());
    const socket = FakeWebSocket.last;
    act(() => socket.open());
    fireEvent.change(composer(), { target: { value: '/login' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(socket.requests).toHaveLength(1));
    act(() =>
      socket.receive(
        replyTo(socket.lastRequest.id, {
          text: 'Entra en https://example.com/login.',
          buttons: [{ label: 'Abrir', url: 'https://example.com/abrir' }],
        }),
      ),
    );

    fireEvent.click(screen.getByRole('link', { name: 'https://example.com/login' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));

    expect(mocked.openLink.mock.calls).toEqual([
      ['https://example.com/login'],
      ['https://example.com/abrir'],
    ]);
  });

  it('says it is loading until the shell answers', () => {
    mocked.snapshot.mockReturnValue(new Promise(() => {}));
    render(<App />);

    expect(screen.getByRole('status').textContent).toBe(strings.status.loading);
  });

  it('says when the shell cannot be reached, and tries again when asked', async () => {
    mocked.snapshot.mockRejectedValueOnce('ipc is gone');
    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(strings.status.shellUnreachable);
    expect(alert.textContent).toContain('ipc is gone');

    mocked.snapshot.mockResolvedValue(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.retry }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.status.running),
    );
  });

  it('stops listening to the shell when the window goes away', async () => {
    const view = await open(runningSnapshot());
    view.unmount();

    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});

describe('snapshots', () => {
  it('follows the events of the shell', async () => {
    await open(runningSnapshot());
    emit(stoppedSnapshot('bot_in_use'));

    expect(screen.getByRole('status').textContent).toBe(strings.status.stopped);
    expect(screen.getByText(strings.status.reasons.bot_in_use)).toBeTruthy();
    expect(composer().disabled).toBe(true);
  });

  it('prefers an event over an older first snapshot', async () => {
    let answer: (snapshot: Snapshot) => void = () => {};
    mocked.snapshot.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    render(<App />);
    await waitFor(() => expect(mocked.onSnapshot).toHaveBeenCalled());
    await act(async () => {});

    emit(runningSnapshot());
    await act(async () => answer(stoppedSnapshot('stopped_by_principal')));

    expect(screen.getByRole('status').textContent).toBe(strings.status.running);
  });
});

describe('commands', () => {
  it('starts and stops the daemon', async () => {
    await open(stoppedSnapshot('stopped_by_principal'));
    fireEvent.click(screen.getByRole('button', { name: strings.status.start }));
    await waitFor(() => expect(mocked.startDaemon).toHaveBeenCalledOnce());

    emit(runningSnapshot());
    fireEvent.click(await screen.findByRole('button', { name: strings.status.stop }));
    await waitFor(() => expect(mocked.stopDaemon).toHaveBeenCalledOnce());
  });

  it('shows the error of a command that failed', async () => {
    mocked.startDaemon.mockRejectedValue('the shell failed: no free port on 127.0.0.1');
    await open(stoppedSnapshot('stopped_by_principal'));
    fireEvent.click(screen.getByRole('button', { name: strings.status.start }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(strings.status.startFailed);
    expect(alert.textContent).toContain('the shell failed: no free port on 127.0.0.1');
  });
});

describe('the setup', () => {
  it('opens by itself when the daemon is not configured', async () => {
    await open(stoppedSnapshot('not_configured'));

    expect(setupHeading()).toBeTruthy();
  });

  it('opens by itself when the daemon becomes not configured later', async () => {
    await open(runningSnapshot());
    emit(stoppedSnapshot('not_configured'));

    expect(setupHeading()).toBeTruthy();
  });

  it('stays closed once the principal closed it, while nothing changes', async () => {
    await open(stoppedSnapshot('not_configured'));
    fireEvent.click(screen.getByRole('button', { name: strings.setup.cancel }));
    expect(setupHeading()).toBeNull();

    emit(stoppedSnapshot('not_configured'));
    expect(setupHeading()).toBeNull();
    expect(screen.getByText(strings.chat.disabled.notConfigured)).toBeTruthy();
  });

  it('opens and closes from the status area', async () => {
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    expect(setupHeading()).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: strings.status.closeSetup }));
    expect(setupHeading()).toBeNull();
  });

  it('saves through the shell and goes back to the chat', async () => {
    await open(stoppedSnapshot('not_configured'));
    mocked.saveSetup.mockResolvedValue({
      daemon: STARTING,
      channel: null,
      setup: FILLED_SETUP,
    });
    fireEvent.change(screen.getByLabelText(strings.setup.botToken), {
      target: { value: '123456:secret' },
    });
    fireEvent.change(screen.getByLabelText(strings.setup.chatId), { target: { value: '4242' } });
    fireEvent.click(screen.getByRole('button', { name: strings.setup.save }));

    await waitFor(() => expect(setupHeading()).toBeNull());
    expect(mocked.saveSetup).toHaveBeenCalledWith({
      telegramBotToken: '123456:secret',
      principalChatId: '4242',
      model: '',
      visionModel: '',
      providerKeys: {},
      timeZone: expect.any(String),
      currency: expect.any(String),
    });
    expect(screen.getByRole('status').textContent).toBe(strings.status.starting);
  });

  // T13: Telegram is optional; a model is enough for the daemon to start.
  it('goes back to the chat after a save with a model and no Telegram', async () => {
    await open(stoppedSnapshot('not_configured'));
    mocked.saveSetup.mockResolvedValue({
      daemon: STARTING,
      channel: null,
      setup: { ...EMPTY_SETUP, model: 'openai/gpt-5-mini' },
    });
    fireEvent.change(screen.getByLabelText(strings.setup.model), {
      target: { value: 'openai/gpt-5-mini' },
    });
    fireEvent.click(screen.getByRole('button', { name: strings.setup.save }));

    await waitFor(() => expect(setupHeading()).toBeNull());
    expect(mocked.saveSetup).toHaveBeenCalledWith({
      principalChatId: '',
      model: 'openai/gpt-5-mini',
      // DK-23 AC2: left empty, photos are read with the same model.
      visionModel: 'openai/gpt-5-mini',
      providerKeys: {},
      timeZone: expect.any(String),
      currency: expect.any(String),
    });
  });

  it('adds the web search through the shell on the first setup, before saving it', async () => {
    await open(stoppedSnapshot('not_configured'));
    mocked.saveSetup.mockResolvedValue({
      daemon: STARTING,
      channel: null,
      setup: { ...EMPTY_SETUP, model: 'openai/gpt-5-mini' },
    });
    fireEvent.change(screen.getByLabelText(strings.setup.model), {
      target: { value: 'openai/gpt-5-mini' },
    });
    fireEvent.click(screen.getByRole('button', { name: strings.setup.save }));

    await waitFor(() => expect(setupHeading()).toBeNull());
    expect(mocked.saveConnection).toHaveBeenCalledExactlyOnceWith({
      name: 'Internet',
      kind: 'process',
      command: 'npx',
      args: ['-y', 'pi-web-access@0.48.0'],
      values: [{ name: 'npm_config_ignore_scripts', value: 'true' }],
      readOnly: ['web_search', 'get_search_content'],
    });
    const [added] = mocked.saveConnection.mock.invocationCallOrder;
    const [saved] = mocked.saveSetup.mock.invocationCallOrder;
    expect(added).toBeLessThan(saved ?? 0);
  });

  it('leaves a server already named Internet as it is', async () => {
    await open(stoppedSnapshot('not_configured'));
    mocked.connections.mockResolvedValue({
      servers: CONNECTIONS.servers.map((server) => ({ ...server, name: 'Internet' })),
      invalid: null,
    });
    mocked.saveSetup.mockResolvedValue({
      daemon: STARTING,
      channel: null,
      setup: { ...EMPTY_SETUP, model: 'openai/gpt-5-mini' },
    });
    fireEvent.change(screen.getByLabelText(strings.setup.model), {
      target: { value: 'openai/gpt-5-mini' },
    });
    fireEvent.click(screen.getByRole('button', { name: strings.setup.save }));

    await waitFor(() => expect(setupHeading()).toBeNull());
    expect(mocked.saveConnection).not.toHaveBeenCalled();
  });

  it('still goes back to the chat after a save with Telegram and no model', async () => {
    await open(stoppedSnapshot('not_configured'));
    mocked.saveSetup.mockResolvedValue({
      daemon: STARTING,
      channel: null,
      setup: { ...EMPTY_SETUP, hasTelegramBotToken: true, principalChatId: '4242' },
    });
    fireEvent.change(screen.getByLabelText(strings.setup.botToken), {
      target: { value: '123456:secret' },
    });
    fireEvent.change(screen.getByLabelText(strings.setup.chatId), { target: { value: '4242' } });
    fireEvent.click(screen.getByRole('button', { name: strings.setup.save }));

    await waitFor(() => expect(setupHeading()).toBeNull());
  });

  it('prefers an event that arrived while saving over the result of the save', async () => {
    await open(stoppedSnapshot('stopped_by_principal'));
    let finish: (snapshot: Snapshot) => void = () => {};
    mocked.saveSetup.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    fireEvent.click(screen.getByRole('button', { name: strings.setup.save }));
    await waitFor(() => expect(mocked.saveSetup).toHaveBeenCalled());

    emit(runningSnapshot());
    await act(async () => finish({ daemon: STARTING, channel: null, setup: FILLED_SETUP }));

    await waitFor(() => expect(setupHeading()).toBeNull());
    expect(screen.getByRole('status').textContent).toBe(strings.status.running);
  });

  it('names the chat model of the setup under the composer (S2)', async () => {
    await open(runningSnapshot({ setup: { ...FILLED_SETUP, visionModel: 'openai/gpt-4o' } }));

    expect(screen.getByText('openai/gpt-4o-mini').classList.contains('composer-model')).toBe(true);
    expect(screen.queryByText('openai/gpt-4o')).toBeNull();
  });

  it('keeps the conversation while the setup is open', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    fireEvent.change(composer(), { target: { value: '23 € cena' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    fireEvent.click(screen.getByRole('button', { name: strings.status.closeSetup }));

    expect(screen.getByText('23 € cena')).toBeTruthy();
  });
});

describe('the window shown again (B48)', () => {
  it('shows the stored conversation again each time the shell shows the window', async () => {
    let shown: () => void = () => {
      throw new Error('the chat is not listening to the shell');
    };
    mocked.onChatShown.mockImplementation(async (handler) => {
      shown = handler;
      return unlisten;
    });
    FakeWebSocket.history = [
      {
        id: 1,
        from: 'principal',
        door: 'telegram',
        text: 'Vivo en Madrid',
        buttons: [],
        channelRef: null,
        at: '2026-11-20T10:00:00.000Z',
      },
    ];
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    expect(await screen.findByText('Vivo en Madrid')).toBeTruthy();

    // Forgotten through Telegram while the window was hidden.
    FakeWebSocket.history = [];
    act(() => shown());

    await waitFor(() => expect(screen.queryByText('Vivo en Madrid')).toBeNull());
  });
});

describe('the ledger import', () => {
  it('opens from the setup, imports through the shell, and goes back to the chat', async () => {
    mocked.importLedger.mockResolvedValue({ outcome: 'imported' });
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    fireEvent.click(screen.getByRole('button', { name: strings.ledger.open }));

    expect(screen.getByRole('heading', { name: strings.ledger.title })).toBeTruthy();
    expect(composer().closest('[hidden]')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(strings.ledger.path), {
      target: { value: '/Users/p/anomander.db' },
    });
    fireEvent.click(screen.getByRole('button', { name: strings.ledger.import }));
    expect(await screen.findByText(strings.ledger.outcome.imported)).toBeTruthy();
    expect(mocked.importLedger).toHaveBeenCalledWith('/Users/p/anomander.db');

    const form = screen.getByRole('form', { name: strings.ledger.title });
    fireEvent.click(within(form).getByRole('button', { name: strings.setup.close }));
    expect(screen.queryByRole('heading', { name: strings.ledger.title })).toBeNull();
    expect(composer().closest('[hidden]')).toBeNull();
  });
});

describe('the connections', () => {
  const heading = () => screen.queryByRole('heading', { name: strings.connections.title });

  it('open from the status area with the servers of the shell, and close back to the chat', async () => {
    mocked.connections.mockResolvedValue(CONNECTIONS);
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openConnections }));

    expect(heading()).toBeTruthy();
    expect(await screen.findByRole('list', { name: strings.connections.servers })).toBeTruthy();
    expect(composer().closest('[hidden]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: strings.status.closeSetup }));
    expect(heading()).toBeNull();
    expect(composer().closest('[hidden]')).toBeNull();
  });

  it('remove a server through the shell', async () => {
    mocked.connections.mockResolvedValue(CONNECTIONS);
    mocked.removeConnection.mockResolvedValue({ servers: [], invalid: null });
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openConnections }));
    fireEvent.click(
      await screen.findByRole('button', { name: strings.connections.removeServer('notes') }),
    );
    fireEvent.click(screen.getByRole('button', { name: strings.connections.confirmRemoveYes }));

    await waitFor(() => expect(screen.getByText(strings.connections.none)).toBeTruthy());
    expect(mocked.removeConnection).toHaveBeenCalledWith('notes');
  });

  it('DK-24 AC3: list the tools allowed always, read on a connection of their own to the channel', async () => {
    mocked.connections.mockResolvedValue(CONNECTIONS);
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openConnections }));
    await screen.findByRole('list', { name: strings.connections.servers });

    expect(FakeWebSocket.instances).toHaveLength(2);
    const socket = FakeWebSocket.last;
    act(() => socket.open());
    await waitFor(() => expect(socket.lastRequest.type).toBe('connection_grants'));
    const grant = { id: 4, server: 'notes', tool: 'create', at: '2026-11-25T09:00:00.000Z' };
    act(() =>
      socket.receive({
        type: 'connection_grants',
        inReplyTo: socket.lastRequest.id,
        grants: [grant],
      }),
    );

    expect(
      await screen.findByRole('button', {
        name: strings.connections.revokeGrantFor('create', 'notes'),
      }),
    ).toBeTruthy();
  });

  it('give way to the setup, which still saves', async () => {
    mocked.connections.mockResolvedValue(CONNECTIONS);
    mocked.saveSetup.mockResolvedValue(runningSnapshot());
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openConnections }));
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    expect(heading()).toBeNull();
    expect(setupHeading()).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: strings.setup.save }));
    await waitFor(() => expect(setupHeading()).toBeNull());
    expect(mocked.saveSetup).toHaveBeenCalledWith({
      principalChatId: '4242',
      model: 'openai/gpt-4o-mini',
      visionModel: 'openai/gpt-4o-mini',
      providerKeys: {},
      timeZone: expect.any(String),
      currency: expect.any(String),
    });
  });
});

// DK-15: the subscription logins, connected and disconnected through the shell.
describe('Memoria (DK-18)', () => {
  const heading = () => screen.queryByRole('heading', { name: strings.memory.title });

  it('opens from the status area, forgets a memory, and the chat shows the stored conversation again', async () => {
    FakeWebSocket.history = [
      {
        id: 1,
        from: 'principal',
        door: 'app',
        text: 'Me llamo Eric',
        buttons: [],
        channelRef: null,
        at: '2026-11-20T10:00:00.000Z',
      },
    ];
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    expect(await screen.findByText('Me llamo Eric')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: strings.status.openMemory }));
    expect(heading()).toBeTruthy();
    expect(composer().closest('[hidden]')).toBeTruthy();
    // Its own connection to the channel of the shell.
    const socket = FakeWebSocket.last;
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => socket.open());
    await waitFor(() => expect(socket.requests.map(({ type }) => type)).toContain('actions'));
    const [memories, actions] = socket.requests;
    act(() =>
      socket.receive({
        type: 'memories',
        inReplyTo: memories?.id ?? '',
        memories: [{ id: 3, text: 'Se llama Eric', mode: 'declared' }],
      }),
    );
    act(() => socket.receive({ type: 'actions', inReplyTo: actions?.id ?? '', actions: [] }));

    fireEvent.click(
      await screen.findByRole('button', { name: strings.memory.forgetLabel('Se llama Eric') }),
    );
    fireEvent.click(screen.getByRole('button', { name: strings.memory.confirmYes }));
    await waitFor(() => expect(socket.lastRequest.type).toBe('forget_memory'));
    // The daemon erased the turn that said it (DK-18 AC4).
    FakeWebSocket.history = [];
    act(() => socket.receive({ type: 'done', inReplyTo: socket.lastRequest.id }));

    fireEvent.click(screen.getByRole('button', { name: strings.status.closeSetup }));
    expect(heading()).toBeNull();
    await waitFor(() => expect(screen.queryByText('Me llamo Eric')).toBeNull());
  });
});

describe('the subscriptions', () => {
  const heading = () => screen.queryByRole('heading', { name: strings.subscriptions.title });
  const CHAT_GPT = { providerId: 'openai', connected: false, login: true };
  const KIMI = { providerId: 'kimi-coding', connected: false, login: true };
  const NONE = { accounts: [CHAT_GPT, KIMI] };

  it('open from the status area with the accounts of the shell, and close back to the chat', async () => {
    mocked.subscriptions.mockResolvedValue(NONE);
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSubscriptions }));

    expect(heading()).toBeTruthy();
    expect(await screen.findByRole('list', { name: strings.subscriptions.accounts })).toBeTruthy();
    expect(composer().closest('[hidden]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: strings.status.closeSetup }));
    expect(heading()).toBeNull();
    expect(composer().closest('[hidden]')).toBeNull();
  });

  it('open from the setup, connect through the shell and follow its steps', async () => {
    mocked.subscriptions.mockResolvedValueOnce(NONE).mockResolvedValue({
      accounts: [{ ...CHAT_GPT, connected: true }, KIMI],
    });
    let step: (step: LoginStep) => void = () => {};
    mocked.onLoginStep.mockImplementation(async (handler) => {
      step = (next) => act(() => handler(next));
      return () => {};
    });
    let answer: (outcome: LoginOutcome) => void = () => {};
    mocked.connectSubscription.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    mocked.answerLogin.mockResolvedValue(undefined);
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    fireEvent.click(screen.getByRole('button', { name: strings.subscriptions.open }));
    expect(heading()).toBeTruthy();

    fireEvent.click(
      await screen.findByRole('button', { name: strings.subscriptions.connectFor('ChatGPT') }),
    );
    expect(mocked.connectSubscription).toHaveBeenCalledWith('openai');
    step({ kind: 'opened' });
    step({ kind: 'prompt' });
    const field = screen.getByLabelText(strings.subscriptions.pasteLabel);
    fireEvent.change(field, { target: { value: 'http://localhost:1455/auth/callback?code=c' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(mocked.answerLogin).toHaveBeenCalledWith('http://localhost:1455/auth/callback?code=c'),
    );

    answer({ outcome: 'connected' });
    await waitFor(() =>
      expect(screen.getAllByRole('status').at(-1)?.textContent).toBe(
        strings.subscriptions.outcome.connected('ChatGPT'),
      ),
    );
    expect(screen.getByText(strings.subscriptions.connected)).toBeTruthy();
  });
});

describe('the expenses (DK-17)', () => {
  it('open from the status area, ask the daemon for them, and close back to the chat', async () => {
    await open(runningSnapshot());
    const chat = FakeWebSocket.last;
    fireEvent.click(screen.getByRole('button', { name: strings.status.openExpenses }));

    expect(screen.getByRole('heading', { name: strings.expenses.title })).toBeTruthy();
    expect(composer().closest('[hidden]')).toBeTruthy();
    const socket = FakeWebSocket.last;
    expect(socket).not.toBe(chat);
    act(() => socket.open());
    expect(socket.lastRequest.type).toBe('expenses');

    const status = within(screen.getByRole('banner'));
    fireEvent.click(status.getByRole('button', { name: strings.status.closeSetup }));
    expect(screen.queryByRole('heading', { name: strings.expenses.title })).toBeNull();
    expect(composer().closest('[hidden]')).toBeNull();
  });

  it('"Corregir" on a row goes to the chat, which shows the question, so the next text corrects it (AC6)', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openExpenses }));
    const socket = FakeWebSocket.last;
    act(() => socket.open());
    act(() =>
      socket.receive({
        type: 'expenses',
        inReplyTo: socket.lastRequest.id,
        month: '2026-11',
        expenses: [
          {
            id: 7,
            date: '2026-11-02',
            merchant: null,
            category: null,
            totalCents: 2300,
            currency: 'EUR',
            mode: 'declared',
            categoryMode: null,
            origin: 'text',
            lines: 0,
          },
        ],
        totals: [{ cents: 2300, currency: 'EUR' }],
        pending: { count: 0, totals: [] },
      }),
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: strings.expenses.correctLabel(formatAmount(2300), formatDate('2026-11-02')),
      }),
    );
    expect(socket.lastRequest).toMatchObject({ type: 'correct_expense', expenseId: 7 });
    // The daemon stored the press and its question in the conversation (R-16 AC3).
    const at = '2026-11-20T10:00:00.000Z';
    FakeWebSocket.history = [
      {
        id: 1,
        from: 'principal',
        door: 'app',
        text: '[botón: Corregir]',
        buttons: [],
        channelRef: null,
        at,
      },
      {
        id: 2,
        from: 'anomander',
        door: 'app',
        text: replies.askCorrection(),
        buttons: [],
        channelRef: null,
        at,
      },
    ];
    act(() =>
      socket.receive(
        replyTo(socket.lastRequest.id, { text: replies.askCorrection(), awaitsText: true }),
      ),
    );

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: strings.expenses.title })).toBeNull(),
    );
    expect(composer().closest('[hidden]')).toBeNull();
    expect(await screen.findByText(replies.askCorrection())).toBeTruthy();
  });
});

describe('thinking', () => {
  const thinking = () => mocked.setThinking.mock.calls.map(([value]) => value);

  it('tells the shell while an answer is owed, so the menu bar shows it', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    expect(thinking()).not.toContain(true);

    fireEvent.change(composer(), { target: { value: '23 € cena' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(thinking().at(-1)).toBe(true));

    act(() => FakeWebSocket.last.receive(replyTo(FakeWebSocket.last.lastRequest.id)));
    await waitFor(() => expect(thinking().at(-1)).toBe(false));
  });

  it('stops when the window goes away while an answer is owed', async () => {
    const view = await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    fireEvent.change(composer(), { target: { value: '23 € cena' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(thinking().at(-1)).toBe(true));

    view.unmount();

    expect(thinking().at(-1)).toBe(false);
  });
});

describe('notifications', () => {
  it('hands every answer to the shell, which notifies when the window is not in front', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    fireEvent.change(composer(), { target: { value: '23 € cena' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));
    expect(mocked.notifyReply).not.toHaveBeenCalled();

    const text = 'Apuntado: 23,00 € en cena.';
    act(() => FakeWebSocket.last.receive(replyTo(FakeWebSocket.last.lastRequest.id, { text })));

    await waitFor(() => expect(mocked.notifyReply).toHaveBeenCalledTimes(1));
    expect(mocked.notifyReply).toHaveBeenCalledWith(text);
  });

  it('does not notify a request the daemon handled without an answer', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    fireEvent.change(composer(), { target: { value: '23 € cena' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));

    act(() =>
      FakeWebSocket.last.receive({ type: 'done', inReplyTo: FakeWebSocket.last.lastRequest.id }),
    );
    await act(async () => {});

    expect(mocked.notifyReply).not.toHaveBeenCalled();
  });
});

describe('usage frictions (DK-21)', () => {
  it("shows in the setup today's AI calls and the daily limit, as the daemon counts them", async () => {
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    const socket = FakeWebSocket.last;
    act(() => socket.open());
    expect(socket.lastRequest.type).toBe('ai_usage');

    act(() =>
      socket.receive({ type: 'ai_usage', inReplyTo: socket.lastRequest.id, calls: 12, limit: 200 }),
    );

    expect(await screen.findByText('Hoy: 12 de 200 llamadas a la IA')).toBeTruthy();
  });

  it('opens the setup from the model named under the composer', async () => {
    await open(runningSnapshot());

    fireEvent.click(
      screen.getByRole('button', { name: `${strings.chat.model} openai/gpt-4o-mini` }),
    );

    expect(setupHeading()).toBeTruthy();
  });
});

// DK-23 AC4: "Probar" asks the daemon on its own connection to the local channel.
describe('"Probar" in the setup', () => {
  const KEY = 'sk-secret-key-the-provider-quoted';
  const probe = async () => {
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    const chat = FakeWebSocket.last;
    fireEvent.click(screen.getByRole('button', { name: strings.setup.probe }));
    const socket = FakeWebSocket.last;
    expect(socket).not.toBe(chat);
    return socket;
  };

  it('sends probe_model with the channel token and shows only its outcome', async () => {
    const socket = await probe();
    expect(socket.url).toBe(CHANNEL.url);
    expect(socket.protocols).toEqual([LOCAL_CHANNEL_PROTOCOL, TOKEN]);
    act(() => socket.open());
    const request = socket.lastRequest;
    expect(request.type).toBe('probe_model');
    // Anything beside the outcome is not shown, even if the daemon sent it.
    act(() =>
      socket.receiveRaw(
        JSON.stringify({
          type: 'probe',
          inReplyTo: request.id,
          outcome: 'key_refused',
          detail: KEY,
        }),
      ),
    );

    expect(await screen.findByText(strings.setup.probeOutcome.key_refused)).toBeTruthy();
    expect(document.documentElement.outerHTML).not.toContain(KEY);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('says the connection was lost when it closes before the answer', async () => {
    const socket = await probe();
    act(() => socket.open());
    act(() => socket.drop());

    expect(await screen.findByText(strings.setup.probeLost)).toBeTruthy();
  });

  it('says it failed when the daemon answers something else', async () => {
    const socket = await probe();
    act(() => socket.open());
    act(() => socket.receive(replyTo(socket.lastRequest.id, { text: 'S-22' })));

    expect(await screen.findByText(strings.setup.probeOutcome.failed)).toBeTruthy();
  });
});
