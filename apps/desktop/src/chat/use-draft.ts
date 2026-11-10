// DK-4 AC2: what waits in the composer until Enter: the text and the files dropped, pasted or
// picked. In memory only.
import { useCallback, useState } from 'react';
import { MAX_ATTACHMENTS, strings } from '../strings.ts';
import {
  type Attachment,
  fitInOneMessage,
  releaseAttachment,
  toAttachment,
  toScreenAttachment,
} from './attachments.ts';

export interface Draft {
  text: string;
  attachments: Attachment[];
  /** Why some files were left out, when they were. */
  notice: string | null;
  setText(text: string): void;
  addFiles(files: File[]): void;
  /** Whether a capture of the screen can wait here: it never travels with receipts. */
  takesScreen(): boolean;
  /** Puts the capture in the draft, in place of an earlier one. */
  addScreen(jpeg: ArrayBuffer): void;
  /** Says why something could not be added. */
  warn(notice: string): void;
  remove(id: string): void;
  /** Empties the draft once it was sent; the message keeps the thumbnails. */
  clear(): void;
}

export const useDraft = (): Draft => {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (attachments.some((attachment) => attachment.screen)) {
        setNotice(strings.chat.screenAlone);
        return;
      }
      const room = MAX_ATTACHMENTS - attachments.length;
      const next = [...attachments, ...files.slice(0, Math.max(room, 0)).map(toAttachment)];
      if (!fitInOneMessage(next)) {
        for (const added of next.slice(attachments.length)) releaseAttachment(added);
        setNotice(strings.chat.tooHeavy);
        return;
      }
      setAttachments(next);
      setNotice(files.length > room ? strings.chat.tooMany : null);
    },
    [attachments],
  );

  const takesScreen = useCallback(() => {
    const free = attachments.every((attachment) => attachment.screen);
    if (!free) setNotice(strings.chat.screenAlone);
    return free;
  }, [attachments]);

  const addScreen = useCallback((jpeg: ArrayBuffer) => {
    setAttachments((current) => {
      // Receipts arrived while the capture was on its way: they stay, the capture is dropped.
      if (current.some((attachment) => !attachment.screen)) return current;
      for (const earlier of current) releaseAttachment(earlier);
      return [toScreenAttachment(jpeg, strings.chat.screenCapture)];
    });
    setNotice(null);
  }, []);

  const remove = useCallback(
    (id: string) => {
      const removed = attachments.find((attachment) => attachment.id === id);
      if (removed !== undefined) releaseAttachment(removed);
      setAttachments(attachments.filter((attachment) => attachment.id !== id));
      setNotice(null);
    },
    [attachments],
  );

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
    takesScreen,
    addScreen,
    warn: setNotice,
    remove,
    clear,
  };
};
