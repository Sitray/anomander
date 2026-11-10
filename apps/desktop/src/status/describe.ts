// DK-1 AC2, DK-2 AC2, DK-6 AC1: what the window says about the daemon and the one thing it
// offers to do about it. Pure, so every state and reason is checked by a test.
import type { DaemonStatus } from '../shell.ts';
import { strings } from '../strings.ts';

/** How the status light looks: lit, coming up, off, or wrong. */
export type StatusTone = 'on' | 'busy' | 'off' | 'alert';

export interface StatusView {
  tone: StatusTone;
  title: string;
  /** Why it is stopped or failing; `null` when there is nothing to add. */
  detail: string | null;
  action: 'start' | 'stop' | 'configure';
  /** The daemon's last error line, shown only while it explains the present state. */
  error: string | null;
}

export const describeStatus = ({ state, reason, lastError }: DaemonStatus): StatusView => {
  const { status } = strings;
  switch (state) {
    case 'running':
      return { tone: 'on', title: status.running, detail: null, action: 'stop', error: null };
    case 'starting':
      return { tone: 'busy', title: status.starting, detail: null, action: 'stop', error: null };
    case 'failing':
      return {
        tone: 'alert',
        title: status.failing,
        detail: status.failingDetail,
        action: 'stop',
        error: lastError,
      };
    case 'stopped': {
      if (reason === 'not_configured') {
        // Starting again cannot help until the setup is complete: lead there instead.
        return {
          tone: 'off',
          title: status.notConfigured,
          detail: status.reasons.not_configured,
          action: 'configure',
          error: lastError,
        };
      }
      // No reason from the shell: it failed before the daemon ran, and only the error says why.
      const detail =
        reason === null
          ? lastError === null
            ? null
            : status.failedToStart
          : status.reasons[reason];
      const calm = reason === 'stopped_by_principal' || detail === null;
      return {
        tone: calm ? 'off' : 'alert',
        title: status.stopped,
        detail,
        action: 'start',
        error: lastError,
      };
    }
  }
};
