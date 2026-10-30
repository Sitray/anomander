// The contract between a front door (apps/telegram) and the daemon. A front door decides who
// may talk (R-1) and which inputs are supported (R-20); the daemon decides what a text means.

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

export interface Reply {
  text: string;
  /** Shown under `text`, in one row (R-6 AC3). */
  buttons?: ReplyButton[];
  /** Called once the front door has sent `text`, to record the delivery. */
  onDelivered?: (delivery: Delivery) => void;
}

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

export type ReceiptHandler = (receipt: PrincipalReceipt) => Promise<Reply>;

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
