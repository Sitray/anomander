import type { DaemonStatus } from '../shell.ts';
import { strings } from '../strings.ts';
import { GearIcon } from '../ui/icons.tsx';

export interface StatusBarProps {
  daemon: DaemonStatus;
  busy: boolean;
  error: string | null;
  /** The setup screen is open: no button leads to it. */
  inSetup: boolean;
  onStart: () => void;
  onStop: () => void;
  onOpenSetup: () => void;
}

const isUp = (daemon: DaemonStatus): boolean =>
  daemon.state === 'running' || daemon.state === 'starting';

/** Why the daemon is not running, in the principal's words; `null` while it runs. */
export const explanation = (daemon: DaemonStatus): string | null => {
  if (isUp(daemon)) return null;
  if (daemon.reason !== null) return strings.reason[daemon.reason];
  return daemon.state === 'failing' ? strings.failingNoReason : strings.stoppedNoReason;
};

/** DK-1 AC2: the last error line, verbatim, once the shell gave up or cannot say why. */
const shownError = (daemon: DaemonStatus): string | null =>
  !isUp(daemon) && (daemon.reason === 'gave_up' || daemon.reason === null)
    ? daemon.lastError
    : null;

/** DK-6 AC1 in the window: whether ANOMANDER runs, and if not, why and what to do. */
export const StatusBar = ({
  daemon,
  busy,
  error,
  inSetup,
  onStart,
  onStop,
  onOpenSetup,
}: StatusBarProps) => {
  const why = explanation(daemon);
  const lastError = shownError(daemon);
  const needsSetup = daemon.reason === 'not_configured' && !isUp(daemon);

  const action = isUp(daemon) ? (
    <button type="button" className="button" disabled={busy} onClick={onStop}>
      {strings.stop}
    </button>
  ) : needsSetup ? (
    !inSetup && (
      <button type="button" className="button button--primary" onClick={onOpenSetup}>
        {strings.configure}
      </button>
    )
  ) : (
    <button type="button" className="button button--primary" disabled={busy} onClick={onStart}>
      {strings.start}
    </button>
  );

  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="toolbar-row" data-tauri-drag-region>
        <div className="status" role="status" data-state={daemon.state} data-tauri-drag-region>
          <span className="status-dot" aria-hidden="true" />
          <span className="status-name">{strings.appName}</span>
          <span className="status-label">{strings.state[daemon.state]}</span>
        </div>
        <div className="toolbar-actions">
          {action}
          {!inSetup && (
            <button
              type="button"
              className="icon-button"
              aria-label={strings.settings}
              title={strings.settings}
              onClick={onOpenSetup}
            >
              <GearIcon />
            </button>
          )}
        </div>
      </div>
      {why !== null && (
        <div className="status-detail" data-state={daemon.state}>
          <p>{why}</p>
          {lastError !== null && (
            <pre className="error-block">
              <code>{lastError}</code>
            </pre>
          )}
        </div>
      )}
      {error !== null && (
        <p className="status-error" role="alert">
          {error}
        </p>
      )}
    </header>
  );
};
