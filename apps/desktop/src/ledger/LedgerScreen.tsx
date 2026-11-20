// DK-12: the import of a ledger brought from a Docker install. Presentational: a path out, and
// the shell's answer in. The path is typed or pasted: a file dialog would be a new plugin.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Field } from '../setup/SetupScreen.tsx';
import type { LedgerImport, LedgerOutcome } from '../shell.ts';
import { ErrorBlock } from '../status/StatusBar.tsx';
import { strings } from '../strings.ts';
import { messageOf } from '../ui/message-of.ts';

export interface LedgerScreenProps {
  /** Imports the ledger at the path; rejects with the shell's own message. */
  onImport: (path: string) => Promise<LedgerImport>;
  onClose: () => void;
}

const { ledger: text } = strings;

/** What the shell itself takes: a full path, or one from the home folder. */
const isFullPath = (path: string): boolean => path.startsWith('/') || path.startsWith('~/');

export function LedgerScreen({ onImport, onClose }: LedgerScreenProps) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<LedgerOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // The screen replaces the chat: start reading it from its title.
  useEffect(() => heading.current?.focus(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (importing) return;
    const typed = path.trim();
    const wrong =
      typed === '' ? text.pathMissing : isFullPath(typed) ? undefined : text.pathNotFull;
    setError(wrong);
    setOutcome(null);
    setFailure(null);
    if (wrong !== undefined) return;

    setImporting(true);
    try {
      setOutcome((await onImport(typed)).outcome);
    } catch (rejected) {
      setFailure(messageOf(rejected));
    }
    setImporting(false);
  };

  return (
    <form
      className="setup"
      noValidate
      aria-labelledby="ledger-title"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !importing) onClose();
      }}
    >
      <div className="setup-body">
        <div className="setup-intro">
          <h2 ref={heading} id="ledger-title" tabIndex={-1}>
            {text.title}
          </h2>
          <p>{text.intro}</p>
          <p>{text.howIntro}</p>
          <pre className="code-block">{text.howCommands}</pre>
        </div>

        <div className="setup-group">
          <Field label={text.path} help={text.pathHelp} error={error}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="code"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="~/Downloads/anomander.db"
                value={path}
                disabled={importing}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => setPath(event.target.value)}
              />
            )}
          </Field>
        </div>
      </div>

      <footer className="setup-footer">
        {failure !== null && (
          <div className="setup-alert" role="alert">
            <p>{text.failed}</p>
            <ErrorBlock label={strings.status.errorDetail}>{failure}</ErrorBlock>
          </div>
        )}
        <p
          className="setup-message"
          role="status"
          data-kind={outcome !== null && outcome !== 'imported' ? 'error' : 'note'}
        >
          {importing ? text.importing : outcome === null ? '' : text.outcome[outcome]}
        </p>
        <div className="setup-actions">
          <button type="button" className="button" disabled={importing} onClick={onClose}>
            {strings.setup.close}
          </button>
          <button type="submit" className="button primary" disabled={importing}>
            {text.import}
          </button>
        </div>
      </footer>
    </form>
  );
}
