// DK-3, DK-4 (docs/desktop-prd.md): the messages of the local channel between the desktop app
// and the daemon, a WebSocket on `127.0.0.1`. Each message is one JSON text frame.
//
// The app presents its token when it connects, as the second WebSocket subprotocol:
// `new WebSocket(url, [LOCAL_CHANNEL_PROTOCOL, token])`. It never travels in the URL.

export const LOCAL_CHANNEL_PROTOCOL = 'anomander.v1';

/** One image the principal dropped in the chat (DK-4 AC2). */
export interface ChatImage {
  mimeType: string;
  /** The file's bytes, in base64. */
  data: string;
}

/** A text the principal typed (DK-4 AC1). */
export interface ChatText {
  type: 'text';
  /** Chosen by the app, unique in its connection; the daemon's answer names it. */
  id: string;
  text: string;
  /** The `channelRef` of the reply this text answers, if any (R-17 AC2). */
  replyTo?: string;
}

/** One file, or several dropped together, as a receipt (DK-4 AC2; R-3 AC4 for several). */
export interface ChatReceipt {
  type: 'receipt';
  id: string;
  images: ChatImage[];
  caption: string | null;
}

/** A press on a button of a reply (DK-4 AC3). */
export interface ChatButtonPress {
  type: 'button';
  id: string;
  /** The button's `data`. */
  data: string;
  /** The `channelRef` of the reply that carries the button. */
  channelRef: string;
}

/**
 * A question about what is on the principal's screen, with the capture the app took when they
 * asked. Only the app can send it: the capture is taken on their machine, at their request.
 */
export interface ChatScreen {
  type: 'screen';
  id: string;
  /** What the principal asks about the screen. */
  text: string;
  image: ChatImage;
}

export type ChatRequest = ChatText | ChatReceipt | ChatButtonPress | ChatScreen;

/** A button under a reply: it comes back as a `ChatButtonPress`, or opens `url`. */
export type ChatButton = { label: string; data: string } | { label: string; url: string };

/** The daemon's answer to the request `inReplyTo`. */
export interface ChatReply {
  type: 'reply';
  inReplyTo: string;
  /** This reply's own reference: `desktop:<uuid>`. */
  channelRef: string;
  text: string;
  buttons: ChatButton[];
  sentAt: string;
}

/** The request `inReplyTo` was handled and has no reply. */
export interface ChatDone {
  type: 'done';
  inReplyTo: string;
}

/** A frame that is not a `ChatRequest`. Nothing was done with it. */
export interface ChatRejected {
  type: 'rejected';
  /** The frame's `id` when it had one. */
  inReplyTo: string | null;
}

export type ChatEvent = ChatReply | ChatDone | ChatRejected;
