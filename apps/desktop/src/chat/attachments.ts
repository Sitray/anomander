// DK-4 AC2: files the principal drops, pastes or picks, read into what a receipt request carries.
// Which files are receipts is the daemon's call (R-20 answers a PDF or a large image), so every
// file is passed on as it is, with its own type.
import type { Attachment } from './chat-state.ts';

/**
 * The daemon closes a connection whose frame is over 64 MiB; base64 grows the bytes by a third,
 * so a receipt stays a little under that, keeping room for the JSON around the images.
 */
export const MAX_RECEIPT_BASE64 = 60 * 1024 * 1024;

const CHUNK = 0x8000;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }
  return btoa(binary);
};

export const readAttachment = async (file: File): Promise<Attachment> => ({
  name: file.name,
  mimeType: file.type === '' ? 'application/octet-stream' : file.type,
  data: toBase64(new Uint8Array(await file.arrayBuffer())),
});

export const isImage = (attachment: Attachment): boolean =>
  attachment.mimeType.startsWith('image/');

/** A `data:` URL for a thumbnail, so no object URL outlives the conversation. */
export const previewUrl = (attachment: Attachment): string =>
  `data:${attachment.mimeType};base64,${attachment.data}`;

export const receiptSize = (attachments: readonly Attachment[]): number =>
  attachments.reduce((total, attachment) => total + attachment.data.length, 0);
