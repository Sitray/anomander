import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type ButtonPress,
  type ChatEvent,
  type ChatRequest,
  type ComputerRequest,
  LOCAL_CHANNEL_PROTOCOL,
  MAX_COMPUTER_STEPS,
  type PrincipalText,
  type ReceiptHandler,
  type ScreenQuestion,
  strings,
} from '@anomander/protocol';
import type { TelegramReply } from '@anomander/telegram';
import { type WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Logger } from '../processor/text-interpreter.ts';

// DK-3, DK-4 (docs/desktop-prd.md): the desktop app's front door, a WebSocket on `127.0.0.1`
// behind the token the app generated for this launch. Like `apps/telegram`, it decides who may
// talk and which inputs are supported (R-20); what an input means is the daemon's decision,
// reached through the same handlers Telegram uses. It only answers: nothing is ever pushed to it
// unasked (DK-4 AC5). The daemon starts it only while `ANOMANDER_LOCAL_TOKEN` is set.

/** The daemon's handlers, the ones the Telegram front door calls too (DK-4 AC1). */
export interface ChatHandlers {
  onText: (message: PrincipalText) => Promise<TelegramReply | null>;
  onReceipt: ReceiptHandler;
  onButton: (press: ButtonPress) => Promise<TelegramReply | null>;
  /** Only the app asks about the screen: Telegram has no capture to send. */
  onScreen: (question: ScreenQuestion) => Promise<TelegramReply | null>;
  /** DK-10: proposes the next step of a task on the computer; it never performs one. */
  onComputer: (request: ComputerRequest) => Promise<TelegramReply | null>;
}

export interface LocalChannelDeps {
  /** `ANOMANDER_LOCAL_TOKEN`: never logged (DK-3 AC2). */
  token: string;
  /** `0` lets the system pick a free port, as tests do. */
  port: number;
  handlers: ChatHandlers;
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
// R-22 AC1: the principal always gets an answer, even when the daemon fails.
const FAILED: TelegramReply = { text: strings.processingFailed() };

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
  const { handlers, logger, now = () => new Date() } = deps;
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

  const answer = (request: ChatRequest): Promise<TelegramReply | null> => {
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
    let reply: TelegramReply | null;
    try {
      reply = await answer(request);
    } catch (error) {
      logger.error(`The daemon failed to handle a ${request.type} from the local channel`, {
        error,
      });
      reply = FAILED;
    }
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
      ...(reply.computer === undefined ? {} : { computer: reply.computer }),
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
