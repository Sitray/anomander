// DK-15: the Suscripciones screen: one row per account a subscription login is made with, its
// state, and one button to connect or disconnect it. Presentational: the shell's view and the
// steps of a login in, a provider ID or the pasted address out.
//
// The address the browser ended on (ChatGPT, when its redirect to this Mac fails) is typed into
// an uncontrolled field, sent once and cleared: it carries a one-time code and never enters
// React state. The shell never sends a token back: the screen only knows which accounts are
// connected.
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Field } from '../setup/SetupScreen.tsx';
import type { LoginOutcome, LoginStep, SubscriptionsView } from '../shell.ts';
import { ErrorBlock } from '../status/StatusBar.tsx';
import { strings } from '../strings.ts';
import { messageOf } from '../ui/message-of.ts';
import { labelOf } from './accounts.ts';

export interface SubscriptionsScreenProps {
  /** Reads the accounts; rejects with the shell's own message. */
  load: () => Promise<SubscriptionsView>;
  /** Logs in to an account; resolves once the browser came back, rejects as the shell does. */
  onConnect: (providerId: string) => Promise<LoginOutcome>;
  /** Hands the pasted address to the login that waits for it. */
  onAnswer: (text: string) => Promise<void>;
  /** Forgets the login of an account and resolves with the accounts now stored. */
  onDisconnect: (providerId: string) => Promise<SubscriptionsView>;
  /** Subscribes to the steps of the running login; answers how to unsubscribe. */
  subscribeSteps: (handler: (step: LoginStep) => void) => () => void;
  onClose: () => void;
}

const { subscriptions: text } = strings;

/** The login that runs, and what the shell has told of it. */
interface Running {
  providerId: string;
  opened: boolean;
  /** A device code to type in the browser. */
  code: string | null;
  /** The flow waits for the address the browser ended on. */
  prompt: boolean;
}

/** What the screen last said, under the list. */
type Note =
  | { kind: 'disconnecting' }
  | { kind: 'outcome'; providerId: string; outcome: LoginOutcome['outcome'] }
  | { kind: 'disconnected'; providerId: string }
  | { kind: 'failed'; what: 'connect' | 'disconnect' | 'answer'; message: string };

const advance = (running: Running, step: LoginStep): Running => {
  switch (step.kind) {
    case 'opened':
      return { ...running, opened: true };
    case 'device_code':
      return { ...running, opened: true, code: step.code };
    case 'prompt':
      return { ...running, prompt: true };
  }
};

interface AnswerProps {
  onAnswer: SubscriptionsScreenProps['onAnswer'];
  onFailed: (message: string) => void;
}

/** The field for the address the browser ended on: sent once, then emptied. */
function AnswerForm({ onAnswer, onFailed }: AnswerProps) {
  const field = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    const typed = field.current?.value.trim() ?? '';
    if (typed === '') {
      setError(text.pasteMissing);
      return;
    }
    setError(undefined);
    setSending(true);
    try {
      await onAnswer(typed);
      if (field.current !== null) field.current.value = '';
    } catch (rejected) {
      onFailed(messageOf(rejected));
    }
    setSending(false);
  };

  return (
    <form className="login-answer" noValidate onSubmit={submit}>
      <Field label={text.pasteLabel} help={text.pasteHelp} error={error}>
        {({ id, describedBy, invalid }) => (
          <div className="key-add-row">
            <input
              ref={field}
              id={id}
              className="code"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={sending}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
            <button type="submit" className="button" disabled={sending}>
              {text.pasteSend}
            </button>
          </div>
        )}
      </Field>
    </form>
  );
}

export function SubscriptionsScreen(props: SubscriptionsScreenProps) {
  const { load, onConnect, onAnswer, onDisconnect, subscribeSteps, onClose } = props;
  const [view, setView] = useState<SubscriptionsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [running, setRunning] = useState<Running | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks for another read.
  useEffect(() => {
    let gone = false;
    load().then(
      (read) => {
        if (!gone) setView(read);
      },
      (error: unknown) => {
        if (!gone) setLoadError(messageOf(error));
      },
    );
    return () => {
      gone = true;
    };
  }, [load, attempt]);

  // The steps belong to the login this screen started; a step with none running is dropped.
  useEffect(
    () => subscribeSteps((step) => setRunning((now) => (now === null ? now : advance(now, step)))),
    [subscribeSteps],
  );

  // The screen replaces the chat: start reading it from its title.
  useEffect(() => heading.current?.focus(), []);

  /** One login or disconnection at a time, and nothing else meanwhile. */
  const busy = running !== null || note?.kind === 'disconnecting';
  /**
   * The screen can be left while the browser waits: the shell keeps what it brings. Not while
   * a change of the Keychain is halfway.
   */
  const held = note?.kind === 'disconnecting';

  const connect = async (providerId: string) => {
    if (busy) return;
    setNote(null);
    setRunning({ providerId, opened: false, code: null, prompt: false });
    let outcome: LoginOutcome['outcome'];
    try {
      ({ outcome } = await onConnect(providerId));
    } catch (error) {
      setNote({ kind: 'failed', what: 'connect', message: messageOf(error) });
      setRunning(null);
      return;
    }
    setNote({ kind: 'outcome', providerId, outcome });
    setRunning(null);
    // The shell kept the login: the list says so once read again, or at the next opening.
    if (outcome === 'connected') {
      try {
        setView(await load());
      } catch {
        // The login stands; the list shows it once it can be read.
      }
    }
  };

  const disconnect = async (providerId: string) => {
    if (busy) return;
    setNote({ kind: 'disconnecting' });
    try {
      setView(await onDisconnect(providerId));
      setNote({ kind: 'disconnected', providerId });
    } catch (error) {
      setNote({ kind: 'failed', what: 'disconnect', message: messageOf(error) });
    }
    // The button that had the focus is gone.
    heading.current?.focus();
  };

  const said =
    running !== null
      ? running.code !== null
        ? text.deviceCode(labelOf(running.providerId))
        : running.opened
          ? text.opened(labelOf(running.providerId))
          : text.starting
      : note === null || note.kind === 'failed'
        ? ''
        : note.kind === 'disconnecting'
          ? text.disconnecting
          : note.kind === 'disconnected'
            ? text.disconnected(labelOf(note.providerId))
            : note.outcome === 'connected'
              ? text.outcome.connected(labelOf(note.providerId))
              : text.outcome[note.outcome];
  const wentWrong = note?.kind === 'outcome' && note.outcome !== 'connected';

  // Accounts no longer offered for login are listed only while connected (R-27 AC6).
  const accounts = view?.accounts.filter((account) => account.login || account.connected) ?? [];

  return (
    <section
      className="setup"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !held) onClose();
      }}
    >
      <div className="setup-body">
        <div className="setup-intro">
          <h2 ref={heading} id={titleId} tabIndex={-1}>
            {text.title}
          </h2>
          <p>{text.intro}</p>
        </div>

        <div className="accounts">
          {loadError !== null ? (
            <div className="setup-alert" role="alert">
              <p>{text.loadFailed}</p>
              <ErrorBlock label={strings.status.errorDetail}>{loadError}</ErrorBlock>
              <button
                type="button"
                className="link"
                onClick={() => {
                  setLoadError(null);
                  setAttempt(attempt + 1);
                }}
              >
                {strings.status.retry}
              </button>
            </div>
          ) : view === null ? (
            <p className="keys-none" role="status">
              {text.loading}
            </p>
          ) : (
            <ul className="keys" aria-label={text.accounts}>
              {accounts.map((account) => {
                const label = labelOf(account.providerId);
                const own = running?.providerId === account.providerId ? running : null;
                return (
                  <li key={account.providerId} data-connected={account.connected || undefined}>
                    <span className="account-name">{label}</span>
                    <span className="key-state">
                      {account.connected ? text.connected : text.notConnected}
                    </span>
                    {account.connected ? (
                      <button
                        type="button"
                        className="link"
                        aria-label={text.disconnectFor(label)}
                        disabled={busy}
                        onClick={() => disconnect(account.providerId)}
                      >
                        {text.disconnect}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="link"
                        aria-label={text.connectFor(label)}
                        disabled={busy}
                        onClick={() => connect(account.providerId)}
                      >
                        {text.connect}
                      </button>
                    )}
                    {own !== null && (own.code !== null || own.prompt) && (
                      <div className="login-step">
                        {own.code !== null && (
                          <p className="login-code">
                            <span className="sr-only">{text.deviceCodeLabel}: </span>
                            <span>{own.code}</span>
                          </p>
                        )}
                        {own.prompt && (
                          <AnswerForm
                            onAnswer={onAnswer}
                            onFailed={(message) =>
                              setNote({ kind: 'failed', what: 'answer', message })
                            }
                          />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <footer className="setup-footer">
        {note?.kind === 'failed' && (
          <div className="setup-alert" role="alert">
            <p>
              {note.what === 'connect'
                ? text.failed
                : note.what === 'answer'
                  ? text.pasteFailed
                  : text.disconnectFailed}
            </p>
            <ErrorBlock label={strings.status.errorDetail}>{note.message}</ErrorBlock>
          </div>
        )}
        {view !== null && (
          <p className="setup-message" role="status" data-kind={wentWrong ? 'error' : 'note'}>
            {said === '' ? text.restartNote : said}
          </p>
        )}
        <div className="setup-actions">
          <button type="button" className="button" disabled={held} onClick={onClose}>
            {text.close}
          </button>
        </div>
      </footer>
    </section>
  );
}
