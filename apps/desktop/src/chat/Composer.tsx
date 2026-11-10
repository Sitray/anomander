import { type KeyboardEvent, useId, useLayoutEffect, useRef } from 'react';
import { MAX_IMAGES, strings } from '../strings.ts';
import { CloseIcon, PaperclipIcon, SendIcon } from '../ui/icons.tsx';
import { isImage, previewUrl } from './attachments.ts';
import type { Attachment } from './chat-state.ts';

export interface ComposerProps {
  text: string;
  attachments: Attachment[];
  notice: string | null;
  tooLong: boolean;
  /** Why nothing can be written now (no channel); `null` when the composer is usable. */
  disabledReason: string | null;
  /** Why a written message cannot leave yet, such as while connecting. */
  waitingReason: string | null;
  onTextChange: (text: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  onSubmit: () => void;
}

/** The textarea grows with its text up to this, then scrolls. */
const MAX_HEIGHT_PX = 132;

export const Composer = ({
  text,
  attachments,
  notice,
  tooLong,
  disabledReason,
  waitingReason,
  onTextChange,
  onAddFiles,
  onRemoveAttachment,
  onSubmit,
}: ComposerProps) => {
  const noteId = useId();
  const hintId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const disabled = disabledReason !== null;
  const empty = text.trim() === '' && attachments.length === 0;
  const canSubmit = !disabled && waitingReason === null && !empty && !tooLong;
  const note = disabledReason ?? (tooLong ? strings.tooLong(text.length) : notice) ?? waitingReason;
  const full = attachments.length >= MAX_IMAGES;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text
  useLayoutEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  // Back from having no channel, the principal can type straight away.
  useLayoutEffect(() => {
    if (!disabled) input.current?.focus();
  }, [disabled]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter is a new line, and Enter that confirms an IME composition is neither.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSubmit) onSubmit();
  };

  return (
    <form
      className="composer"
      data-disabled={disabled || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      {attachments.length > 0 && (
        // biome-ignore lint/a11y/noRedundantRoles: WebKit drops list semantics without it
        <ul className="tray" role="list">
          {attachments.map((attachment, index) => (
            // Staged files have no id of their own; the tray is short and rebuilt on change.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={index} className="tray-item">
              {isImage(attachment) ? (
                <img className="tray-thumb" src={previewUrl(attachment)} alt={attachment.name} />
              ) : (
                <span className="file-chip tray-thumb">{attachment.name}</span>
              )}
              <button
                type="button"
                className="tray-remove"
                aria-label={strings.removeAttachment(attachment.name)}
                onClick={() => onRemoveAttachment(index)}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-row">
        <label
          className="icon-button"
          data-disabled={disabled || full || undefined}
          title={strings.attach}
        >
          <input
            type="file"
            className="visually-hidden"
            aria-label={strings.attach}
            accept="image/*,application/pdf"
            multiple
            disabled={disabled || full}
            onChange={(event) => {
              onAddFiles(Array.from(event.target.files ?? []));
              // Picking the same file again must fire `change` again.
              event.target.value = '';
            }}
          />
          <PaperclipIcon />
        </label>
        <textarea
          ref={input}
          className="composer-input"
          rows={1}
          aria-label={strings.composerLabel}
          aria-describedby={note === null ? hintId : `${noteId} ${hintId}`}
          aria-invalid={tooLong || undefined}
          placeholder={strings.composerPlaceholder}
          value={text}
          disabled={disabled}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            onAddFiles(files);
          }}
        />
        <button
          type="submit"
          className="send-button"
          aria-label={strings.send}
          disabled={!canSubmit}
        >
          <SendIcon />
        </button>
      </div>
      <p
        className="composer-note"
        id={noteId}
        data-tone={!disabled && (tooLong || notice !== null) ? 'error' : undefined}
      >
        {note}
      </p>
      <p className="visually-hidden" id={hintId}>
        {strings.composerHint}
      </p>
    </form>
  );
};
