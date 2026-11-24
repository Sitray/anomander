// DK-18: "Memoria", what ANOMANDER remembers about the principal (R-23) and what it did for them
// (DK-14), each with "Olvidar", asked first. Every memory says whether the principal said it or
// it was deduced (PRD principle 2); anything can be forgotten for real (principle 5).
import type { ChatAction, ChatMemory } from '@anomander/protocol';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { LocalChannel } from '../shell.ts';
import { strings } from '../strings.ts';
import { AlertIcon } from '../ui/icons.tsx';
import { type Forgotten, type Listed, useMemory } from './use-memory.ts';

export interface MemoryScreenProps {
  /** `null` while the daemon is not running. */
  channel: LocalChannel | null;
  onClose: () => void;
  /** A memory was forgotten, and the stored conversation with it (DK-16 AC5). */
  onForgotten?: () => void;
}

const { memory: text } = strings;

type Kind = 'memory' | 'action';
/** The item whose "Olvidar" was pressed, waiting for "Sí, olvidar". */
type Asking = { kind: Kind; id: number } | null;

export function MemoryScreen({ channel, onClose, onForgotten }: MemoryScreenProps) {
  const memory = useMemory(channel);
  const [asking, setAsking] = useState<Asking>(null);
  const [forgetting, setForgetting] = useState(false);
  const [problem, setProblem] = useState<Exclude<Forgotten, 'done'> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const question = useId();

  // The screen replaces the chat: start reading it from its title.
  useEffect(() => heading.current?.focus(), []);

  const forgetNow = async (kind: Kind, id: number) => {
    setForgetting(true);
    const outcome = await memory.forget(kind, id);
    setForgetting(false);
    setAsking(null);
    setProblem(outcome === 'done' ? null : outcome);
    // The chat follows a forget that erased, or may have erased, the stored conversation.
    if (kind === 'memory' && outcome !== 'not_done') onForgotten?.();
  };

  /** "Olvidar", or the question it opened. */
  const forgetControl = (kind: Kind, id: number, words: string): ReactNode =>
    asking?.kind === kind && asking.id === id ? (
      <span className="memory-confirm">
        <span id={question}>{kind === 'memory' ? text.confirmMemory : text.confirmAction}</span>
        <button
          type="button"
          className="link"
          aria-describedby={question}
          disabled={forgetting}
          onClick={() => void forgetNow(kind, id)}
        >
          {forgetting ? text.forgetting : text.confirmYes}
        </button>
        <button
          type="button"
          className="link"
          aria-describedby={question}
          // biome-ignore lint/a11y/noAutofocus: the button it replaces had the focus.
          autoFocus
          disabled={forgetting}
          onClick={() => setAsking(null)}
        >
          {text.keep}
        </button>
      </span>
    ) : (
      <button
        type="button"
        className="link"
        aria-label={text.forgetLabel(words)}
        disabled={forgetting}
        onClick={() => {
          setProblem(null);
          setAsking({ kind, id });
        }}
      >
        {text.forget}
      </button>
    );

  return (
    <section
      className="setup"
      aria-labelledby="memory-title"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || forgetting) return;
        if (asking !== null) setAsking(null);
        else onClose();
      }}
    >
      <div className="setup-body">
        <div className="setup-intro">
          <h2 ref={heading} id="memory-title" tabIndex={-1}>
            {text.title}
          </h2>
          <p>{text.intro}</p>
        </div>

        {channel === null || memory.connection !== 'open' ? (
          <p className="memory-state" role="status">
            {channel === null ? text.closed : text.connecting}
          </p>
        ) : (
          <>
            <MemoryList
              title={text.known}
              listed={memory.memories}
              none={text.knownNone}
              onRetry={memory.retryMemories}
            >
              {(item: ChatMemory) => (
                <li key={item.id}>
                  <span className="memory-words">{item.text}</span>
                  <span className="memory-mode" data-mode={item.mode}>
                    {item.mode === 'declared' ? text.declared : text.inferred}
                  </span>
                  {forgetControl('memory', item.id, item.text)}
                </li>
              )}
            </MemoryList>
            <MemoryList
              title={text.done}
              listed={memory.actions}
              none={text.doneNone}
              onRetry={memory.retryActions}
            >
              {(item: ChatAction) => (
                <li key={item.id}>
                  <span className="memory-about">
                    <time dateTime={item.at}>{text.when(item.at)}</time>
                    <span>{text.what[item.what]}</span>
                    {item.door === 'telegram' && <span>{text.viaTelegram}</span>}
                  </span>
                  <span className="memory-words">{item.task}</span>
                  <span className="memory-about">
                    <span>{text.outcome(item.outcome)}</span>
                  </span>
                  {forgetControl('action', item.id, item.task)}
                </li>
              )}
            </MemoryList>
          </>
        )}
      </div>

      <footer className="setup-footer">
        {problem !== null && (
          <p className="message-problem" role="alert">
            <AlertIcon />
            <span>{problem === 'unknown' ? text.forgetUnknown : text.forgetFailed}</span>
          </p>
        )}
        <div className="setup-actions">
          <button type="button" className="button" disabled={forgetting} onClick={onClose}>
            {text.close}
          </button>
        </div>
      </footer>
    </section>
  );
}

interface MemoryListProps<T> {
  title: string;
  listed: Listed<T>;
  none: string;
  onRetry: () => void;
  children: (item: T) => ReactNode;
}

/** One section: its items, or why there are none to show. */
function MemoryList<T>({ title, listed, none, onRetry, children }: MemoryListProps<T>) {
  const id = useId();
  return (
    <section className="setup-group memory-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {listed.state === 'loading' ? (
        <p className="keys-none">{text.loading}</p>
      ) : listed.state === 'failed' ? (
        <p className="keys-none memory-failed">
          <span>{text.failed}</span>
          <button type="button" className="link" onClick={onRetry}>
            {text.retry}
          </button>
        </p>
      ) : listed.items.length === 0 ? (
        <p className="keys-none">{none}</p>
      ) : (
        <ul className="keys memory-list">{listed.items.map(children)}</ul>
      )}
    </section>
  );
}
