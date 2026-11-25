// DK-22 (B29): what the shell's notifications show. "Mostrar contenido" shows the start of the
// message, as before; "Solo avisar" only says there is something, so nothing of it reaches a
// locked screen. Saved at once in the shell's settings, apart from the setup's "Guardar": it
// starts nothing again.
import { useId, useState } from 'react';
import type { NotificationMode } from '../shell.ts';
import { strings } from '../strings.ts';

export interface NotificationsSettingProps {
  /** The mode in force; absent is `content`, the default. */
  mode: NotificationMode | undefined;
  /** Saves `mode` in the shell; rejects when it could not. */
  onChoose: (mode: NotificationMode) => Promise<unknown>;
}

const MODES = ['content', 'notice_only'] as const;

export function NotificationsSetting({ mode = 'content', onChoose }: NotificationsSettingProps) {
  const text = strings.notifications;
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = { content: text.content, notice_only: text.noticeOnly };
  const help = { content: text.contentHelp, notice_only: text.noticeOnlyHelp };

  const choose = (next: NotificationMode) => {
    if (next === mode || saving) return;
    setSaving(true);
    setFailed(false);
    onChoose(next)
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  };

  return (
    <fieldset aria-busy={saving}>
      <legend>{text.title}</legend>
      {MODES.map((option) => (
        <div className="field" key={option}>
          <label className="check" htmlFor={`${id}-${option}`}>
            <input
              id={`${id}-${option}`}
              type="radio"
              name={id}
              checked={mode === option}
              disabled={saving}
              aria-describedby={`${id}-${option}-note`}
              onChange={() => choose(option)}
            />
            {label[option]}
          </label>
          <p className="field-note" id={`${id}-${option}-note`}>
            {help[option]}
          </p>
        </div>
      ))}
      {failed && (
        <p className="field-note" role="alert">
          {text.failed}
        </p>
      )}
    </fieldset>
  );
}
