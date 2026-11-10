// DK-6: the daemon's status, always on screen. Presentational: the status in, commands out.
import { useId, useState } from 'react';
import type { DaemonStatus } from '../shell.ts';
import { strings } from '../strings.ts';
import { ChatIcon, CloseIcon, Mark, SlidersIcon } from '../ui/icons.tsx';
import { describeStatus, type StatusView } from './describe.ts';

export type Command = 'start' | 'stop';

/** A command the shell refused, with its own message. */
export interface CommandError {
  command: Command;
  message: string;
}

export interface StatusBarProps {
  /** `null` until the shell answered. */
  daemon: DaemonStatus | null;
  /** The command in progress. */
  busy: Command | null;
  commandError: CommandError | null;
  setupOpen: boolean;
  onStart: () => void;
  onStop: () => void;
  onToggleSetup: () => void;
  onDismissError: () => void;
}

/** Longer than this, or on several lines, an error starts collapsed. */
const LONG_ERROR = 120;

const LOADING: StatusView = {
  tone: 'busy',
  title: strings.status.loading,
  detail: null,
  action: 'stop',
  error: null,
};

/** DK-1 AC2: the daemon's last error line, verbatim. */
export function ErrorBlock({ label, children }: { label: string; children: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = children.length > LONG_ERROR || children.includes('\n');
  return (
    <div className="error-block">
      <figure aria-label={label}>
        {/* Focusable when clipped or scrolling, so the keyboard can reach all of it. */}
        <pre id={id} tabIndex={long ? 0 : undefined} data-clamped={long && !open ? '' : undefined}>
          {children}
        </pre>
      </figure>
      {long && (
        <button
          type="button"
          className="link"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          {open ? strings.status.showLess : strings.status.showAll}
        </button>
      )}
    </div>
  );
}

export function StatusBar(props: StatusBarProps) {
  const { daemon, busy, commandError, setupOpen } = props;
  const { status } = strings;
  const view = daemon === null ? LOADING : describeStatus(daemon);

  const action = {
    start: { label: busy === 'start' ? status.startBusy : status.start, run: props.onStart },
    stop: { label: busy === 'stop' ? status.stopBusy : status.stop, run: props.onStop },
    configure: { label: status.configure, run: props.onToggleSetup },
  }[view.action];
  // The setup is already open: its own button, beside this one, is the way back.
  const offered = daemon !== null && !(view.action === 'configure' && setupOpen);

  return (
    <header className="status" data-tone={view.tone}>
      <div className="status-row">
        <Mark />
        <p className="status-title" role="status">
          {view.title}
        </p>
        <div className="status-actions">
          {offered && (
            <button
              type="button"
              className={view.action === 'stop' ? 'button' : 'button primary'}
              disabled={busy !== null}
              onClick={action.run}
            >
              {action.label}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={setupOpen ? status.closeSetup : status.openSetup}
            title={setupOpen ? status.closeSetup : status.openSetup}
            disabled={daemon === null}
            onClick={props.onToggleSetup}
          >
            {setupOpen ? <ChatIcon /> : <SlidersIcon />}
          </button>
        </div>
      </div>
      {(view.detail !== null || view.error !== null) && (
        <div className="status-detail">
          {view.detail !== null && <p>{view.detail}</p>}
          {view.error !== null && <ErrorBlock label={status.lastError}>{view.error}</ErrorBlock>}
        </div>
      )}
      {commandError !== null && (
        <div className="status-alert" role="alert">
          <div className="status-alert-body">
            <p>{commandError.command === 'start' ? status.startFailed : status.stopFailed}</p>
            <ErrorBlock label={status.errorDetail}>{commandError.message}</ErrorBlock>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={status.dismiss}
            title={status.dismiss}
            onClick={props.onDismissError}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </header>
  );
}
