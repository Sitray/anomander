// The contract between a front door (apps/telegram) and the daemon. A front door decides who
// may talk (R-1) and which inputs are supported (R-20); the daemon decides what a text means.

import type { ComputerAction } from './local-channel.ts';

/** A text the principal sent, already past the principal check. */
export interface PrincipalText {
  text: string;
  /** Where it came from, stored as the assertion source: `telegram:<message_id>`. */
  channelRef: string;
  /** When the message was sent, as an ISO 8601 UTC timestamp. */
  receivedAt: string;
  /** The message this text replies to in the chat, if any: `telegram:<message_id>` (R-17 AC2). */
  replyTo?: string;
}

/** A question about the principal's screen, with the capture taken when they asked. */
export interface ScreenQuestion {
  text: string;
  image: { mimeType: string; data: Uint8Array };
  channelRef: string;
  receivedAt: string;
}

/** One step of a task on the principal's computer (DK-10), with the screen as it is now. */
export interface ComputerRequest {
  task: string;
  image: { mimeType: string; data: Uint8Array };
  /** The steps already performed, as they were described, oldest first. */
  done: string[];
  channelRef: string;
  receivedAt: string;
}

/** A task for the servers the principal connected (DK-11). */
export interface ConnectRequest {
  task: string;
  channelRef: string;
  receivedAt: string;
}

/** Proof that a reply reached the principal (R-9 AC2). */
export interface Delivery {
  /** The sent message: `telegram:<message_id>`. */
  channelRef: string;
  deliveredAt: string;
}

/** A button under a reply. Its `data` comes back when the principal presses it (R-17 AC1). */
export interface ReplyButton {
  label: string;
  /** `decision:<id>:<option index>`, built with `decisionButtons`. */
  data: string;
}

/**
 * DK-13: the ways a request may go besides an answer in words: a look at the screen, a task on
 * the computer, a task with the servers the principal connected.
 */
export const ROUTE_KINDS = ['screen', 'computer', 'connect'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/** DK-13 AC1: a request the processor sent one of those ways, with what was asked. */
export interface Route {
  to: RouteKind;
  task: string;
}

/** DK-11 AC13: a connection the app adds in one press. */
export type Offer = 'web_search';

export interface Reply {
  text: string;
  /** Shown under `text`, in one row (R-6 AC3). */
  buttons?: ReplyButton[];
  /** DK-10: the action `text` proposes on the principal's computer. Only the app can show it. */
  computer?: ComputerAction;
  /** With `computer`: whether the principal must allow it first (DK-10 AC1). */
  confirm?: boolean;
  /**
   * DK-13 AC2: what `text` announces. The daemon runs `connect` itself; a look or a task on the
   * computer only the app can start.
   */
  route?: Route;
  /**
   * DK-11 AC13: what `text` says is missing and the app can add in one press, then ask again.
   * Only the app shows it; Telegram sends `text` alone.
   */
  offer?: Offer;
  /**
   * R-29 AC3: files sent after `text`, as documents, such as the ledger export. Only Telegram
   * sends them; the daemon never gives them to the app.
   */
  files?: ReplyFile[];
  /** Called once the front door has sent `text`, to record the delivery. */
  onDelivered?: (delivery: Delivery) => void;
}

/** A file on the daemon's disk, sent under `name`. */
export interface ReplyFile {
  path: string;
  name: string;
}

/** A button that opens `url` instead of coming back as a press, such as `Abrir` (R-27 AC2). */
export interface LinkButton {
  label: string;
  url: string;
}

export type DoorButton = ReplyButton | LinkButton;

/**
 * A `Reply` whose buttons may also be links: what a front door sends, Telegram or the desktop
 * app's local channel (DK-4 AC1).
 */
export type DoorReply = Omit<Reply, 'buttons'> & { buttons?: readonly DoorButton[] };

export type TextHandler = (message: PrincipalText) => Promise<Reply>;

/** One image of a receipt. The bytes are fetched only when the daemon asks for them. */
export interface ReceiptImage {
  mimeType: string;
  load(): Promise<Uint8Array>;
}

/** A receipt the principal sent: one photo or image file, or an album (R-3, R-20). */
export interface PrincipalReceipt {
  /** In the order they were sent; several only for an album (R-3 AC4). */
  images: ReceiptImage[];
  /** The caption, a declaration of the principal (R-3 AC5); `null` when there is none. */
  caption: string | null;
  /** `telegram:<message_id>`, or `telegram:album:<media_group_id>` for an album. */
  channelRef: string;
  /** When the (first) message was sent, as an ISO 8601 UTC timestamp. */
  receivedAt: string;
}

/** `null` sends nothing, such as a receipt queued after the day's S-10 (R-12 AC2). */
export type ReceiptHandler = (receipt: PrincipalReceipt) => Promise<Reply | null>;

/** The buttons of a pending decision: option `i` sends `decision:<id>:<i>` (R-17 AC1). */
export const decisionButtons = (decisionId: number, options: readonly string[]): ReplyButton[] =>
  options.map((label, index) => ({ label, data: `decision:${decisionId}:${index}` }));

/** A press on a reply button (R-17 AC1), already past the principal check. */
export interface ButtonPress {
  /** The button's `data`: `decision:<id>:<option index>`. */
  data: string;
  /** The message that carries the button: `telegram:<message_id>`. */
  channelRef: string;
  pressedAt: string;
}

export type ButtonHandler = (press: ButtonPress) => Promise<Reply>;

/** Sends a message the principal did not ask for, such as S-13 or S-14 (R-8, R-19). */
export type Notify = (message: Reply) => Promise<void>;
