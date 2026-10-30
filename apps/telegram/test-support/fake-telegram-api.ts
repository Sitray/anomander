// A fake Telegram Bot API for integration tests (PRD §14.1): a real grammY bot long-polls it
// through the `apiRoot` option. Push updates in, read what the bot sent out.
//
//   const api = await startFakeTelegramApi();
//   const bot = createTelegramBot({ token: api.token, apiRoot: api.apiRoot, ... });
//   api.push(updates.text(principal, '23 € cena'));
//   const [reply] = await api.waitForSent(1);
//   await bot.stop();
//   await api.close();

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Update } from 'grammy/types';

/** A `sendMessage` call the bot made. */
export interface SentMessage {
  chatId: number;
  text: string;
  /** The `message_id` the fake assigned to the sent message. */
  messageId: number;
  /** The raw request body. */
  payload: Record<string, unknown>;
}

export interface FakeTelegramApi {
  /** Pass to grammY as `client.apiRoot`. */
  apiRoot: string;
  /** The only token the fake accepts. */
  token: string;
  /** Queues an update for `getUpdates`; the fake assigns its `update_id`. */
  push(update: IncomingUpdate): void;
  sent: SentMessage[];
  /** Resolves once at least `count` messages were sent; rejects after `timeoutMs`. */
  waitForSent(count: number, timeoutMs?: number): Promise<SentMessage[]>;
  close(): Promise<void>;
}

export type IncomingUpdate = Omit<Update, 'update_id'>;

const TOKEN = '123456:fake-token';
const BOT_USER = {
  id: 123456,
  is_bot: true,
  first_name: 'Anomander',
  username: 'anomander_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};
// A long poll on an empty queue is held at most this long, so tests stay fast.
const MAX_HOLD_MS = 1000;

export const startFakeTelegramApi = async (): Promise<FakeTelegramApi> => {
  const queue: Update[] = [];
  const sent: SentMessage[] = [];
  const onChange = new Set<() => void>();
  const notify = () => {
    for (const listener of onChange) listener();
  };
  let nextUpdateId = 1;
  let nextMessageId = 1;

  const methods: Record<string, (body: Record<string, unknown>) => Promise<unknown> | unknown> = {
    getMe: () => BOT_USER,
    deleteWebhook: () => true,
    getUpdates: (body) => getUpdates(body),
    sendMessage: (body) => {
      const chatId = Number(body.chat_id);
      const message = {
        message_id: nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        from: BOT_USER,
        text: String(body.text),
      };
      sent.push({ chatId, text: message.text, messageId: message.message_id, payload: body });
      notify();
      return message;
    },
  };

  const getUpdates = async (body: Record<string, unknown>): Promise<Update[]> => {
    // Telegram semantics: an offset confirms every update below it.
    const offset = Number(body.offset ?? 0);
    while (queue.length > 0 && (queue[0]?.update_id ?? 0) < offset) queue.shift();
    if (queue.length === 0) {
      const holdMs = Math.min(Number(body.timeout ?? 0) * 1000, MAX_HOLD_MS);
      await waitFor(() => queue.length > 0, holdMs);
    }
    const limit = Number(body.limit ?? 100);
    return queue.slice(0, limit);
  };

  const waitFor = (ready: () => boolean, ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        onChange.delete(check);
        resolve();
      };
      const check = () => {
        if (ready()) done();
      };
      const timer = setTimeout(done, ms);
      onChange.add(check);
    });

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? '');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>;
    if (match?.[1] !== TOKEN) {
      respond(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
      return;
    }
    const method = methods[match[2] ?? ''];
    const result = method === undefined ? true : await method(body);
    respond(res, 200, { ok: true, result });
  };

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    apiRoot: `http://127.0.0.1:${port}`,
    token: TOKEN,
    sent,
    push: (update) => {
      queue.push({ ...update, update_id: nextUpdateId++ } as Update);
      notify();
    },
    waitForSent: async (count, timeoutMs = 2000) => {
      await waitFor(() => sent.length >= count, timeoutMs);
      if (sent.length < count) {
        throw new Error(
          `Expected ${count} sent messages, got ${sent.length}: ${JSON.stringify(sent)}`,
        );
      }
      return sent.slice();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
};

const respond = (res: ServerResponse, status: number, body: unknown) => {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Who sent a message, and where. Defaults: the sender is the chat, in a private chat. */
export interface Sender {
  chatId: number;
  fromId?: number;
  chatType?: 'private' | 'group' | 'supergroup';
}

/** The `date` of every built message: 2026-10-30T10:00:00Z. */
export const MESSAGE_DATE = Date.UTC(2026, 9, 30, 10) / 1000;

let nextIncomingMessageId = 500;

type PrivateOrGroupMessage = NonNullable<Update['message']>;

const message = (sender: Sender, content: Record<string, unknown>): PrivateOrGroupMessage => {
  const fromId = sender.fromId ?? sender.chatId;
  const chatType = sender.chatType ?? 'private';
  return {
    message_id: nextIncomingMessageId++,
    date: MESSAGE_DATE,
    chat:
      chatType === 'private'
        ? { id: sender.chatId, type: 'private', first_name: 'Test' }
        : { id: sender.chatId, type: chatType, title: 'Test group' },
    from: { id: fromId, is_bot: false, first_name: 'Test' },
    ...content,
  } as PrivateOrGroupMessage;
};

const file = (id: string, fileSize: number) => ({
  file_id: id,
  file_unique_id: `${id}-unique`,
  file_size: fileSize,
});

/** Builders for the updates a principal (or anyone else) can send. */
export const updates = {
  text: (sender: Sender, text: string): IncomingUpdate => ({ message: message(sender, { text }) }),
  edited: (sender: Sender, text: string): IncomingUpdate => ({
    edited_message: { ...message(sender, { text }), edit_date: MESSAGE_DATE + 60 },
  }),
  document: (sender: Sender, mimeType: string, fileSize = 1024): IncomingUpdate => ({
    message: message(sender, {
      document: { ...file('document', fileSize), mime_type: mimeType, file_name: 'file' },
    }),
  }),
  photo: (sender: Sender, fileSize = 1024): IncomingUpdate => ({
    message: message(sender, {
      photo: [
        { ...file('photo-small', 1024), width: 90, height: 160 },
        { ...file('photo-large', fileSize), width: 1280, height: 720 },
      ],
    }),
  }),
  voice: (sender: Sender): IncomingUpdate => ({
    message: message(sender, { voice: { ...file('voice', 1024), duration: 3 } }),
  }),
  video: (sender: Sender): IncomingUpdate => ({
    message: message(sender, {
      video: { ...file('video', 1024), width: 640, height: 480, duration: 3 },
    }),
  }),
  sticker: (sender: Sender): IncomingUpdate => ({
    message: message(sender, {
      sticker: {
        ...file('sticker', 1024),
        type: 'regular',
        width: 512,
        height: 512,
        is_animated: false,
        is_video: false,
      },
    }),
  }),
  location: (sender: Sender): IncomingUpdate => ({
    message: message(sender, { location: { latitude: 40.4168, longitude: -3.7038 } }),
  }),
  contact: (sender: Sender): IncomingUpdate => ({
    message: message(sender, { contact: { phone_number: '+34600000000', first_name: 'Ana' } }),
  }),
};
