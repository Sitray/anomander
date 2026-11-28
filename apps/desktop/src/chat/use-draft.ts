// DK-4 AC2: what waits in the composer until Enter: the text and the files dropped, pasted or
// picked. In memory only.
import { useCallback, useState } from 'react';
import { MAX_ATTACHMENTS, strings } from '../strings.ts';
import {
  type Attachment,
  fitInOneMessage,
  isImage,
  releaseAttachment,
  toAttachment,
} from './attachments.ts';

export interface Draft {
  text: string;
  attachments: Attachment[];
  /** Why some files were left out, when they were. */
  notice: string | null;
  setText(text: string): void;
  addFiles(files: File[]): void;
  /** Says why something could not be added. */
  warn(notice: string): void;
  /** Takes back `notice` when it is the one shown, leaving any other as it is. */
  withdraw(notice: string): void;
  remove(id: string): void;
  /** Empties the draft once it was sent; the message keeps the thumbnails. */
  clear(): void;
}

export const useDraft = (): Draft => {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const addFiles = useCallback(
    (offered: File[]) => {
      if (offered.length === 0) return;
      // DK-21: R-20 reads images only, so anything else stays out instead of being refused later.
      const files = offered.filter(isImage);
      const room = MAX_ATTACHMENTS - attachments.length;
      const next = [...attachments, ...files.slice(0, Math.max(room, 0)).map(toAttachment)];
      if (!fitInOneMessage(next)) {
        for (const added of next.slice(attachments.length)) releaseAttachment(added);
        setNotice(strings.chat.tooHeavy);
        return;
      }
      setAttachments(next);
      // B70: when both happened, both are said; images left out must never go unmentioned.
      const notImages = files.length < offered.length;
      const overflow = files.length > room;
      setNotice(
        notImages && overflow
          ? strings.chat.onlyImagesAndTooMany
          : notImages
            ? strings.chat.onlyImages
            : overflow
              ? strings.chat.tooMany
              : null,
      );
    },
    [attachments],
  );

  const remove = useCallback(
    (id: string) => {
      const removed = attachments.find((attachment) => attachment.id === id);
      if (removed !== undefined) releaseAttachment(removed);
      setAttachments(attachments.filter((attachment) => attachment.id !== id));
      setNotice(null);
    },
    [attachments],
  );

  const withdraw = useCallback((notice: string) => {
    setNotice((shown) => (shown === notice ? null : shown));
  }, []);

  const clear = useCallback(() => {
    setText('');
    setAttachments([]);
    setNotice(null);
  }, []);

  return {
    text,
    attachments,
    notice,
    setText,
    addFiles,
    warn: setNotice,
    withdraw,
    remove,
    clear,
  };
};
