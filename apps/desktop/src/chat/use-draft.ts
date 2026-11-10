// What the principal is writing: the text and the files waiting to go as one receipt. It lives
// above the chat screen so a trip to the setup screen does not lose it.
import { useCallback, useState } from 'react';
import { MAX_IMAGES, MAX_TEXT_LENGTH, strings } from '../strings.ts';
import { MAX_RECEIPT_BASE64, readAttachment, receiptSize } from './attachments.ts';
import type { Attachment } from './chat-state.ts';

export interface Draft {
  text: string;
  attachments: Attachment[];
  /** A short note about the last thing that could not be done, such as too many images. */
  notice: string | null;
  /** The text is over what the daemon accepts; shown and not sent. */
  tooLong: boolean;
  setText: (text: string) => void;
  addFiles: (files: File[]) => void;
  removeAttachment: (index: number) => void;
  /** Sends the draft when there is something to send; returns whether it did. */
  submit: () => boolean;
}

export interface DraftSink {
  sendText: (text: string) => void;
  sendReceipt: (attachments: Attachment[], caption: string | null) => void;
}

export const useDraft = ({ sendText, sendReceipt }: DraftSink): Draft => {
  const [text, setTextState] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const tooLong = text.length > MAX_TEXT_LENGTH;

  const setText = useCallback((value: string) => {
    setTextState(value);
    setNotice(null);
  }, []);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setNotice(null);
    Promise.allSettled(files.map(readAttachment)).then((results) => {
      const read = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      setAttachments((current) => {
        const next = [...current, ...read];
        if (next.length > MAX_IMAGES) setNotice(strings.tooManyImages);
        else if (read.length < results.length) setNotice(strings.unreadableFile);
        return next.slice(0, MAX_IMAGES);
      });
    });
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((current) => current.filter((_, position) => position !== index));
    setNotice(null);
  }, []);

  const submit = (): boolean => {
    const trimmed = text.trim();
    if (tooLong) return false;
    if (attachments.length > 0) {
      if (receiptSize(attachments) > MAX_RECEIPT_BASE64) {
        setNotice(strings.tooHeavy);
        return false;
      }
      sendReceipt(attachments, trimmed === '' ? null : trimmed);
    } else if (trimmed === '') {
      return false;
    } else {
      sendText(trimmed);
    }
    setTextState('');
    setAttachments([]);
    setNotice(null);
    return true;
  };

  return { text, attachments, notice, tooLong, setText, addFiles, removeAttachment, submit };
};
