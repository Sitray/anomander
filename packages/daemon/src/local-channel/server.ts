import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type ButtonPress,
  type ChatAction,
  type ChatConnectionGrant,
  type ChatEvent,
  type ChatExpensesRequest,
  type ChatHistoryRequest,
  type ChatMemory,
  type ChatRequest,
  type ChatStoredMessage,
  type ComputerRequest,
  type ConnectRequest,
  type DoorReply,
  HISTORY_LIMIT,
  LOCAL_CHANNEL_PROTOCOL,
  MAX_COMPUTER_STEPS,
  type PrincipalText,
  type ReceiptHandler,
  type ScreenQuestion,
  strings,
} from '@anomander/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Logger } from '../processor/ports.ts';
import { type ExpensesMonth, isMonth } from '../read-api/month.ts';

// DK-3, DK-4 (docs/desktop-prd.md): the desktop app's front door, a WebSocket on `127.0.0.1`
// behind the token the app generated for this launch. Like `apps/telegram`, it decides who may
// talk and which inputs are supported (R-20); what an input means is the daemon's decision,
// reached through the same handlers Telegram uses. It only answers: nothing is ever pushed to it
// unasked (DK-4 AC5); the app asks for the stored conversation of both doors instead (DK-16).
// The daemon starts it only while `ANOMANDER_LOCAL_TOKEN` is set.

/** The daemon's handlers, the ones the Telegram front door calls too (DK-4 AC1). */
export interface ChatHandlers {
  onText: (message: PrincipalText) => Promise<DoorReply | null>;
  onReceipt: ReceiptHandler;
  onButton: (press: ButtonPress) => Promise<DoorReply | null>;
  /** Only the app asks about the screen: Telegram has no capture to send. */
  onScreen: (question: ScreenQuestion) => Promise<DoorReply | null>;
  /** DK-10: proposes the next step of a task on the computer; it never performs one. */
  onComputer: (request: ComputerRequest) => Promise<DoorReply | null>;
  /** DK-11: runs a task with the servers the principal connected. */
  onConnect: (request: ConnectRequest) => Promise<DoorReply | null>;
}

/** DK-16: the conversation kept in the local database, from both doors. */
export interface StoredConversation {
  /** The latest `limit` messages, oldest first. */
  messages(limit: number): ChatStoredMessage[];
  /**
   * Erases it for real, and with it the recent turns. The daemon runs it in the chat's turn, so a
   * turn of either door that runs is stored before the erase, never after it (DK-16 AC4).
   */
  clear(): Promise<void> | void;
}

/**
 * DK-18: what ANOMANDER remembers about the principal (R-23) and what it did (DK-14), as the
 * window's "Memoria" lists them. Nothing of it is ever logged (R-23 AC8, DK-14 AC5).
 */
export interface StoredMemory {
  /** The current memories, in the order they were remembered. */
  memories(): ChatMemory[];
  /**
   * Forgets one memory for real (R-23 AC6, AC7) and the turns of the stored conversation that
   * say it (DK-18 AC4); one no longer current is left alone. In the chat's turn, as `clear`.
   */
  forgetMemory(id: number): Promise<void> | void;
  /** The actions kept, the latest first. */
  actions(): ChatAction[];
  /** Erases one action and the turns that say it, for real (DK-18 AC5). In the chat's turn. */
  forgetAction(id: number): Promise<void> | void;
}

/** DK-17: the expenses of a month, read from the views of RA-1, and their row actions. */
export interface ExpensesLedger {
  /** `month` is `YYYY-MM`; absent, the current month in `TZ`. Throws when it cannot be read. */
  month(month: string | undefined): ExpensesMonth;
  /**
   * AC6: "Deshacer" on a row, as the expense's "Deshacer" in the chat (R-7 AC5). In the chat's
   * turn; the press and its reply are kept in the stored conversation.
   */
  undo(expenseId: number): Promise<DoorReply | null>;
  /** AC6: "Corregir" on a row, as the expense's "Corregir" in the chat (R-7 AC6). In the chat's turn. */
  correct(expenseId: number): Promise<DoorReply | null>;
}

/**
 * DK-24 AC3: the tools the principal allowed with "Permitir siempre", for the window's
 * "Conexiones", and "Quitar". Nothing of a call's arguments is in them.
 */
export interface ConnectionGrants {
  /** Those in force, by server and then tool. */
  list(): ChatConnectionGrant[];
  /** Revokes one; nothing when it is not one in force. */
  revoke(id: number): void;
}

export interface LocalChannelDeps {
  /** `ANOMANDER_LOCAL_TOKEN`: never logged (DK-3 AC2). */
  token: string;
  /** `0` lets the system pick a free port, as tests do. */
  port: number;
  handlers: ChatHandlers;
  conversation: StoredConversation;
  memory: StoredMemory;
  expenses: ExpensesLedger;
  /** Absent, as in the setup guide, the list is empty and nothing can be revoked. */
  grants?: ConnectionGrants;
  logger: Logger;
  now?: () => Date;
}

export interface LocalChannelAddress {
  host: string;
  port: number;
}

export interface LocalChannel {
  /** Resolves once the channel listens; rejects when it cannot, for example a port in use. */
  listening: Promise<LocalChannelAddress>;
  stop(): Promise<void>;
}

// DK-3 AC1: this machine only. It is not configurable.
const HOST = '127.0.0.1';
// R-20: the size Telegram accepts, so both doors take the same images.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** One frame: an album of large images in base64. A longer frame closes its connection. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
// R-22 AC1: the principal always gets an answer, even when the daemon fails. Built when sent, so
// it is in the language the daemon chose at startup, not the one of this module's import.
const failed = (): DoorReply => ({ text: strings.processingFailed() });

const id = z.string().min(1).max(64);
const requestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    id,
    // The longest text Telegram delivers.
    text: z.string().min(1).max(4096),
    replyTo: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('receipt'),
    id,
    // R-3 AC4: as many images as a Telegram album holds.
    images: z
      .array(z.strictObject({ mimeType: z.string().min(1), data: z.base64().min(1) }))
      .min(1)
      .max(10),
    caption: z.string().nullable(),
  }),
  z.strictObject({
    type: z.literal('button'),
    id,
    data: z.string().min(1),
    channelRef: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('screen'),
    id,
    text: z.string().trim().min(1).max(4096),
    image: z.strictObject({ mimeType: z.string().startsWith('image/'), data: z.base64().min(1) }),
  }),
  z.strictObject({
    type: z.literal('computer'),
    id,
    task: z.string().trim().min(1).max(4096),
    image: z.strictObject({ mimeType: z.string().startsWith('image/'), data: z.base64().min(1) }),
    done: z.array(z.string().min(1).max(1024)).max(MAX_COMPUTER_STEPS),
  }),
  z.strictObject({
    type: z.literal('connect'),
    id,
    task: z.string().trim().min(1).max(4096),
  }),
  // DK-16: a larger limit is capped at `HISTORY_LIMIT`.
  z.strictObject({ type: z.literal('history'), id, limit: z.int().positive().optional() }),
  z.strictObject({ type: z.literal('clear_history'), id }),
  // DK-18
  z.strictObject({ type: z.literal('memories'), id }),
  z.strictObject({ type: z.literal('forget_memory'), id, memoryId: z.int().positive() }),
  z.strictObject({ type: z.literal('actions'), id }),
  z.strictObject({ type: z.literal('forget_action'), id, actionId: z.int().positive() }),
  // DK-17: a month of the calendar, `YYYY-MM`.
  z.strictObject({
    type: z.literal('expenses'),
    id,
    month: z.string().refine(isMonth).optional(),
  }),
  // DK-17 AC6
  z.strictObject({ type: z.literal('undo_expense'), id, expenseId: z.int().positive() }),
  z.strictObject({ type: z.literal('correct_expense'), id, expenseId: z.int().positive() }),
  // DK-24 AC3
  z.strictObject({ type: z.literal('connection_grants'), id }),
  z.strictObject({ type: z.literal('revoke_connection_grant'), id, grantId: z.int().positive() }),
]);

/** The request in a frame, or the `id` it carried when it is not one. */
const parseRequest = (frame: string): ChatRequest | { rejected: string | null } => {
  let raw: unknown;
  try {
    raw = JSON.parse(frame);
  } catch {
    return { rejected: null };
  }
  const parsed = requestSchema.safeParse(raw);
  // Zod types an absent `replyTo` as `undefined`; `answer` leaves it out.
  if (parsed.success) return parsed.data as ChatRequest;
  const carried = id.safeParse((raw as { id?: unknown } | null)?.id);
  return { rejected: carried.success ? carried.data : null };
};

/** A SHA-256 digest, so the comparison below takes the same time whatever the lengths. */
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

const decodedBytes = (base64: string): number => Math.floor((base64.length * 3) / 4);

/** What R-20 answers to files that are not receipt images, as `apps/telegram` does. */
const unsupported = (images: ChatRequest & { type: 'receipt' }): string | undefined => {
  const types = images.images.map((image) => image.mimeType);
  if (types.includes('application/pdf')) return strings.pdfNotSupported();
  if (types.some((type) => !type.startsWith('image/'))) return strings.unsupportedInput();
  return images.images.some((image) => decodedBytes(image.data) > MAX_FILE_BYTES)
    ? strings.imageTooLarge()
    : undefined;
};

export const startLocalChannel = (deps: LocalChannelDeps): LocalChannel => {
  const { handlers, conversation, memory, expenses, logger, now = () => new Date() } = deps;
  const grants: ConnectionGrants = deps.grants ?? {
    list: () => [],
    revoke: () => {
      throw new Error('no store to revoke a grant from');
    },
  };
  const expected = digest(deps.token);
  // DK-3 AC2: exactly the protocol and then the token, compared in constant time.
  const authorized = (header: string | undefined): boolean => {
    const offered = (header ?? '').split(',').map((value) => value.trim());
    return (
      offered.length === 2 &&
      offered[0] === LOCAL_CHANNEL_PROTOCOL &&
      timingSafeEqual(digest(offered[1] ?? ''), expected)
    );
  };

  /** The requests answered with a list in `handle`, not with a reply. */
  type Listing =
    | ChatHistoryRequest
    | ChatExpensesRequest
    | { type: 'memories' | 'actions' | 'connection_grants' };
  /** DK-18: the list a `memories` or `actions` request asks for. Their words are never logged. */
  const listed = (request: ChatRequest & { type: 'memories' | 'actions' }): ChatEvent =>
    request.type === 'memories'
      ? { type: 'memories', inReplyTo: request.id, memories: memory.memories() }
      : { type: 'actions', inReplyTo: request.id, actions: memory.actions() };

  const answer = (request: Exclude<ChatRequest, Listing>): Promise<DoorReply | null> => {
    const channelRef = `desktop:${randomUUID()}`;
    const at = now().toISOString();
    switch (request.type) {
      case 'text':
        return handlers.onText({
          text: request.text,
          channelRef,
          receivedAt: at,
          ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
        });
      case 'button':
        return handlers.onButton({
          data: request.data,
          channelRef: request.channelRef,
          pressedAt: at,
        });
      case 'screen':
        if (decodedBytes(request.image.data) > MAX_FILE_BYTES) {
          return Promise.resolve({ text: strings.imageTooLarge() });
        }
        return handlers.onScreen({
          text: request.text,
          image: {
            mimeType: request.image.mimeType,
            data: new Uint8Array(Buffer.from(request.image.data, 'base64')),
          },
          channelRef,
          receivedAt: at,
        });
      // DK-16 S5: `done` once it is erased; when it cannot be, the reply says it failed.
      case 'clear_history':
        return (async () => {
          await conversation.clear();
          return null;
        })();
      // DK-18: `done` once it is erased, as `clear_history`.
      case 'forget_memory':
        return (async () => {
          await memory.forgetMemory(request.memoryId);
          return null;
        })();
      case 'forget_action':
        return (async () => {
          await memory.forgetAction(request.actionId);
          return null;
        })();
      // DK-24 AC3: "Quitar", answered `done`.
      case 'revoke_connection_grant':
        return (async () => {
          grants.revoke(request.grantId);
          return null;
        })();
      // DK-17 AC6: answered as the expense's buttons in the chat are.
      case 'undo_expense':
        return expenses.undo(request.expenseId);
      case 'correct_expense':
        return expenses.correct(request.expenseId);
      case 'connect':
        return handlers.onConnect({ task: request.task, channelRef, receivedAt: at });
      case 'computer':
        if (decodedBytes(request.image.data) > MAX_FILE_BYTES) {
          return Promise.resolve({ text: strings.imageTooLarge() });
        }
        return handlers.onComputer({
          task: request.task,
          image: {
            mimeType: request.image.mimeType,
            data: new Uint8Array(Buffer.from(request.image.data, 'base64')),
          },
          done: request.done,
          channelRef,
          receivedAt: at,
        });
      case 'receipt': {
        const refusal = unsupported(request);
        if (refusal !== undefined) return Promise.resolve({ text: refusal });
        return handlers.onReceipt({
          images: request.images.map(({ mimeType, data }) => ({
            mimeType,
            load: async () => new Uint8Array(Buffer.from(data, 'base64')),
          })),
          caption: request.caption,
          channelRef,
          receivedAt: at,
        });
      }
    }
  };

  const send = (socket: WebSocket, event: ChatEvent): Promise<void> =>
    new Promise((resolve, reject) => {
      socket.send(JSON.stringify(event), (error) => (error ? reject(error) : resolve()));
    });

  const handle = async (socket: WebSocket, frame: string | null): Promise<void> => {
    const request = frame === null ? { rejected: null } : parseRequest(frame);
    if ('rejected' in request) {
      logger.warn('local channel rejected a frame that is not a request');
      await send(socket, { type: 'rejected', inReplyTo: request.rejected });
      return;
    }
    let answered: DoorReply | ChatStoredMessage[] | ChatEvent | null;
    try {
      // DK-16 S4: the latest messages, oldest first. Their words are never logged.
      // DK-17: the month's expenses, never logged either.
      answered =
        request.type === 'history'
          ? conversation.messages(Math.min(request.limit ?? HISTORY_LIMIT, HISTORY_LIMIT))
          : request.type === 'memories' || request.type === 'actions'
            ? listed(request)
            : request.type === 'expenses'
              ? { type: 'expenses', inReplyTo: request.id, ...expenses.month(request.month) }
              : request.type === 'connection_grants'
                ? { type: 'connection_grants', inReplyTo: request.id, grants: grants.list() }
                : await answer(request);
    } catch (error) {
      logger.error(`The daemon failed to handle a ${request.type} from the local channel`, {
        error,
      });
      answered = failed();
    }
    if (Array.isArray(answered)) {
      await send(socket, { type: 'history', inReplyTo: request.id, messages: answered });
      return;
    }
    if (answered !== null && 'type' in answered) {
      await send(socket, answered);
      return;
    }
    const reply = answered;
    if (reply === null) {
      await send(socket, { type: 'done', inReplyTo: request.id });
      return;
    }
    const channelRef = `desktop:${randomUUID()}`;
    const sentAt = now().toISOString();
    await send(socket, {
      type: 'reply',
      inReplyTo: request.id,
      channelRef,
      text: reply.text,
      buttons: [...(reply.buttons ?? [])],
      sentAt,
      // DK-10 AC1: an action always says whether it must be allowed; asking is the default.
      ...(reply.computer === undefined
        ? {}
        : { computer: reply.computer, confirm: reply.confirm !== false }),
      // DK-13 AC2: the daemon ran a task with connections itself; the app starts the others.
      ...(reply.route === undefined || reply.route.to === 'connect'
        ? {}
        : { route: { to: reply.route.to, task: reply.route.task } }),
      // DK-11 AC13: what the app can add in one press.
      ...(reply.offer === undefined ? {} : { offer: reply.offer }),
    });
    // R-9 AC2: only a reply that left through the socket was delivered.
    reply.onDelivered?.({ channelRef, deliveredAt: sentAt });
  };

  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: () => LOCAL_CHANNEL_PROTOCOL,
  });
  sockets.on('connection', (socket: WebSocket) => {
    socket.on('error', (error) => logger.warn('local channel connection error', { error }));
    socket.on('message', (data, isBinary) => {
      handle(socket, isBinary ? null : data.toString()).catch((error: unknown) => {
        // The app closed its window before the answer: the reply was not delivered.
        logger.warn('local channel could not send an answer', { error });
      });
    });
  });

  // DK-3 AC2: anything that is not the app's WebSocket is closed with no data, plain HTTP too.
  const server = createServer((request) => request.socket.destroy());
  // Node answers these by itself (400, 431, 100 Continue) unless the socket is closed first.
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('checkContinue', (request) => request.socket.destroy());
  server.on('checkExpectation', (request) => request.socket.destroy());
  server.on('upgrade', (request, socket, head) => {
    if (!authorized(request.headers['sec-websocket-protocol'])) {
      logger.warn('local channel closed a connection that did not present the token');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (accepted) =>
      sockets.emit('connection', accepted, request),
    );
  });

  const listening = new Promise<LocalChannelAddress>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, HOST, () => {
      server.off('error', reject);
      server.on('error', (error) => logger.error('local channel server error', { error }));
      const { address, port } = server.address() as AddressInfo;
      resolve({ host: address, port });
    });
  });

  return {
    listening,
    stop: async () => {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      if (server.listening) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
    },
  };
};
