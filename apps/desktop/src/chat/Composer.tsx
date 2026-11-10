// DK-4: where the principal types and where files wait. Presentational: the draft in, edits out.
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { strings } from '../strings.ts';
import {
  ArrowUpIcon,
  CloseIcon,
  FileIcon,
  PaperclipIcon,
  PointerIcon,
  ScreenIcon,
} from '../ui/icons.tsx';
import type { Attachment } from './attachments.ts';

/** The longest `text` the daemon accepts. */
const MAX_TEXT_LENGTH = 4096;

export interface ComposerProps {
  text: string;
  attachments: Attachment[];
  /** Why some files were left out. */
  notice: string | null;
  /** There is no channel: nothing can be typed. */
  disabled: boolean;
  /** Why nothing can be sent right now; `null` when it can. */
  blocked: string | null;
  onText: (text: string) => void;
  onFiles: (files: File[]) => void;
  /** Asks for a capture of the screen; absent where the window cannot take one. */
  onScreen?: () => void;
  /** DK-10: whether the next message is a task on the computer; absent where it cannot be. */
  control?: { on: boolean; onToggle: () => void };
  onRemove: (id: string) => void;
  onSubmit: () => void;
}

export function Composer(props: ComposerProps) {
  const { text, attachments, notice, disabled, blocked, onText, onFiles, onRemove, onSubmit } =
    props;
  const { onScreen, control } = props;
  const reasonId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const empty = text.trim() === '' && attachments.length === 0;

  // Grows with what is typed, up to the height the stylesheet allows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again whenever the text changes.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);

  // The chat is where the principal writes: once there is a channel, the caret is already there,
  // unless they are busy somewhere else.
  useEffect(() => {
    if (!disabled && document.activeElement === document.body) textarea.current?.focus();
  }, [disabled]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter confirms an input method's candidate before it may send anything; WebKit reports
    // that Enter with keyCode 229 once the composition has already ended.
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    onSubmit();
  };

  return (
    <form className="composer" onSubmit={submit}>
      {blocked !== null && (
        <p className="composer-reason" id={reasonId}>
          {blocked}
        </p>
      )}
      {notice !== null && (
        <p className="composer-notice" role="status">
          {notice}
        </p>
      )}
      {control?.on === true && <p className="composer-mode">{strings.chat.computerMode}</p>}
      <div className="composer-box" data-disabled={disabled || undefined}>
        {attachments.length > 0 && (
          <ul className="tray" aria-label={strings.chat.attachments}>
            {attachments.map((attachment) => (
              <li key={attachment.id} className="tray-item">
                {attachment.previewUrl === null ? (
                  <span className="tray-file">
                    <FileIcon />
                    <span className="file-name">{attachment.name}</span>
                  </span>
                ) : (
                  <img src={attachment.previewUrl} alt={attachment.name} />
                )}
                <button
                  type="button"
                  className="tray-remove"
                  aria-label={strings.chat.removeAttachment(attachment.name)}
                  onClick={() => onRemove(attachment.id)}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-row">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-label={strings.chat.attach}
            onChange={(event) => {
              onFiles(Array.from(event.target.files ?? []));
              // So picking the same file twice in a row is still a change.
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={strings.chat.attach}
            title={strings.chat.attach}
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <PaperclipIcon />
          </button>
          {onScreen !== undefined && (
            <button
              type="button"
              className="icon-button"
              aria-label={strings.chat.screen}
              title={strings.chat.screen}
              disabled={disabled}
              onClick={onScreen}
            >
              <ScreenIcon />
            </button>
          )}
          {control !== undefined && (
            <button
              type="button"
              className="icon-button"
              aria-label={strings.chat.computer}
              aria-pressed={control.on}
              title={strings.chat.computer}
              disabled={disabled}
              onClick={control.onToggle}
            >
              <PointerIcon />
            </button>
          )}
          <textarea
            ref={textarea}
            className="composer-input"
            rows={1}
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            placeholder={
              disabled
                ? ''
                : control?.on === true
                  ? strings.chat.computerPlaceholder
                  : strings.chat.placeholder
            }
            aria-label={strings.chat.message}
            aria-describedby={blocked === null ? undefined : reasonId}
            disabled={disabled}
            onChange={(event) => onText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              onFiles(files);
            }}
          />
          <button
            type="submit"
            className="send"
            aria-label={strings.chat.send}
            title={strings.chat.send}
            disabled={blocked !== null || empty}
          >
            <ArrowUpIcon />
          </button>
        </div>
      </div>
    </form>
  );
}
