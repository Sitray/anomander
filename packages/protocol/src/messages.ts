// The contract between a front door (apps/telegram) and the daemon. A front door decides who
// may talk (R-1) and which inputs are supported (R-20); the daemon decides what a text means.

/** A text the principal sent, already past the principal check. */
export interface PrincipalText {
  text: string;
  /** Where it came from, stored as the assertion source: `telegram:<message_id>`. */
  channelRef: string;
  /** When the message was sent, as an ISO 8601 UTC timestamp. */
  receivedAt: string;
}

/** Proof that a reply reached the principal (R-9 AC2). */
export interface Delivery {
  /** The sent message: `telegram:<message_id>`. */
  channelRef: string;
  deliveredAt: string;
}

export interface Reply {
  text: string;
  /** Called once the front door has sent `text`, to record the delivery. */
  onDelivered?: (delivery: Delivery) => void;
}

export type TextHandler = (message: PrincipalText) => Promise<Reply>;
