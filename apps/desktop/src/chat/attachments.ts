// DK-4 AC2: the files waiting in the composer, each with its thumbnail. Only images get here
// (DK-21): R-20 reads nothing else, so the composer leaves a PDF out and says why.
import type { ChatImage } from '@anomander/protocol';

export interface Attachment {
  id: string;
  file: File;
  name: string;
  /** What the daemon is told the file is. */
  mimeType: string;
  /** An object URL for the thumbnail, in memory only; `null` for a file that is not an image. */
  previewUrl: string | null;
}

/**
 * The daemon closes a connection whose frame is over 64 MB. Base64 grows a file by a third, so
 * together the files of one message stay under this many bytes.
 */
const MAX_MESSAGE_BYTES = 45 * 1024 * 1024;

/** DK-21: what R-20 reads as a receipt: a file whose MIME type is `image/*`. */
export const isImage = (file: File): boolean => file.type.startsWith('image/');

export const toAttachment = (file: File): Attachment => {
  const mimeType = file.type === '' ? 'application/octet-stream' : file.type;
  return {
    id: crypto.randomUUID(),
    file,
    name: file.name,
    mimeType,
    previewUrl: mimeType.startsWith('image/') ? URL.createObjectURL(file) : null,
  };
};

/** Frees the thumbnail of an attachment that was removed before it was sent. */
export const releaseAttachment = (attachment: Attachment): void => {
  if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
};

export const fitInOneMessage = (attachments: readonly Attachment[]): boolean =>
  attachments.reduce((bytes, { file }) => bytes + file.size, 0) <= MAX_MESSAGE_BYTES;

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.onload = () => {
      // A data URL: `data:<type>;base64,<bytes>`.
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });

/** A capture the shell took, as a request carries it. */
export const encodeJpeg = async (jpeg: ArrayBuffer): Promise<ChatImage> => ({
  mimeType: 'image/jpeg',
  data: await toBase64(new File([jpeg], 'screen.jpg', { type: 'image/jpeg' })),
});

/** The files as a `receipt` request carries them. */
export const encodeAttachments = (attachments: readonly Attachment[]): Promise<ChatImage[]> =>
  Promise.all(
    attachments.map(async ({ file, mimeType }) => ({ mimeType, data: await toBase64(file) })),
  );
