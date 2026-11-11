// DK-11: the connections screen: the servers of `mcp.json`, added, edited and removed one at a
// time. Presentational: the shell's view in, one `ConnectionInput` or a name out.
//
// A value (of a variable or a header) is typed into an uncontrolled field and kept in a ref, so
// it never enters React state or a DOM attribute, and it is dropped once saved. The shell never
// sends one back: of what is stored the screen only has the names.
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Field } from '../setup/SetupScreen.tsx';
import type { ConnectionInput, ConnectionServer, ConnectionsView } from '../shell.ts';
import { ErrorBlock } from '../status/StatusBar.tsx';
import { strings } from '../strings.ts';
import { messageOf } from '../ui/message-of.ts';
import { boxed, isServerName, isServerUrl, unboxed } from './validation.ts';

export interface ConnectionsScreenProps {
  /** Reads the servers; rejects with the shell's own message. */
  load: () => Promise<ConnectionsView>;
  /** Saves one server and resolves with the servers now in the file; rejects as the shell does. */
  onSave: (server: ConnectionInput) => Promise<ConnectionsView>;
  /** Removes one server; otherwise as `onSave`. */
  onRemove: (name: string) => Promise<ConnectionsView>;
  onClose: () => void;
}

const { connections: text } = strings;

type FieldName = 'name' | 'command' | 'url' | 'valueName' | 'value';
type Errors = Partial<Record<FieldName, string>>;
/** What saving will do to a value. */
type ValueChange = 'store' | 'remove';

interface FormProps {
  /** The server to edit; `null` adds one. */
  server: ConnectionServer | null;
  /** The names of the other servers. */
  taken: string[];
  onSave: ConnectionsScreenProps['onSave'];
  onSaved: (view: ConnectionsView) => void;
  onCancel: () => void;
}

function ServerForm({ server, taken, onSave, onSaved, onCancel }: FormProps) {
  const [name, setName] = useState(server?.name ?? '');
  const [kind, setKind] = useState(server?.kind ?? 'process');
  const [command, setCommand] = useState(server?.kind === 'process' ? server.command : '');
  const [args, setArgs] = useState(server?.kind === 'process' ? boxed(server.args) : '');
  const [url, setUrl] = useState(server?.kind === 'http' ? server.url : '');
  const [readOnly, setReadOnly] = useState(boxed(server?.readOnly ?? []));
  const [valueName, setValueName] = useState('');
  const [changes, setChanges] = useState<Record<string, ValueChange>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  const value = useRef<HTMLInputElement>(null);
  /** The values to store, by name. Never rendered. */
  const typed = useRef(new Map<string, string>());
  const heading = useRef<HTMLHeadingElement>(null);
  const ids = useId();

  // The form replaces the list: start reading it from its title.
  useEffect(() => heading.current?.focus(), []);

  const stored = server?.values ?? [];
  const isStored = (valueName: string) => stored.some((kept) => kept.name === valueName);

  const change = (valueName: string, to: ValueChange | undefined) => {
    setChanges(({ [valueName]: _dropped, ...rest }) =>
      to === undefined ? rest : { ...rest, [valueName]: to },
    );
    if (to !== 'store') typed.current.delete(valueName);
  };

  /**
   * Takes the value typed in the "add" row, when there is one. Returns what is wrong with it, or
   * `null` when it was taken or the row is empty.
   */
  const takeTypedValue = (required: boolean): Errors | null => {
    const typedName = valueName.trim();
    const typedValue = value.current?.value.trim() ?? '';
    if (typedName === '' && typedValue === '' && !required) return null;
    if (typedName === '') return { valueName: text.valueNameMissing };
    if (typedValue === '') return { value: text.valueMissing };
    typed.current.set(typedName, typedValue);
    change(typedName, 'store');
    if (value.current !== null) value.current.value = '';
    setValueName('');
    return null;
  };

  const addValue = () => {
    const wrong = takeTypedValue(true);
    setErrors(({ valueName: _name, value: _value, ...rest }) => ({ ...rest, ...wrong }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const serverName = name.trim();
    const target =
      kind === 'process'
        ? {
            kind,
            command: command.trim(),
            args: unboxed(args, server?.kind === 'process' ? server.args : undefined),
          }
        : { kind, url: url.trim() };
    const wrong: Errors = {
      ...(!isServerName(serverName)
        ? { name: text.nameInvalid }
        : taken.includes(serverName)
          ? { name: text.nameTaken }
          : {}),
      ...(target.kind === 'process' && target.command === ''
        ? { command: text.commandMissing }
        : {}),
      ...(target.kind === 'http' && !isServerUrl(target.url) ? { url: text.urlInvalid } : {}),
      // A value typed but not added is still meant to be saved.
      ...takeTypedValue(false),
    };
    setErrors(wrong);
    setRejection(null);
    if (Object.keys(wrong).length > 0) return;

    // Read from the ref as well: the `change` of `takeTypedValue` has not reached `changes` yet.
    const kept = stored
      .map((keptValue) => keptValue.name)
      .filter((keptName) => changes[keptName] !== 'remove' || typed.current.has(keptName));
    const added = [...typed.current.keys()].filter((typedName) => !isStored(typedName));
    const input: ConnectionInput = {
      ...(server === null ? {} : { original: server.name }),
      name: serverName,
      ...target,
      values: [...kept, ...added].map((valueName) => {
        const typedValue = typed.current.get(valueName);
        // Without a value the shell keeps the one it has.
        return typedValue === undefined
          ? { name: valueName }
          : { name: valueName, value: typedValue };
      }),
      readOnly: unboxed(readOnly, server?.readOnly),
    };

    setSaving(true);
    try {
      const saved = await onSave(input);
      typed.current.clear();
      onSaved(saved);
    } catch (error) {
      setRejection(messageOf(error));
      setSaving(false);
    }
  };

  const valueNames = [
    ...stored.map((kept) => kept.name),
    ...Object.keys(changes).filter((changed) => !isStored(changed)),
  ];
  const valueError = errors.valueName ?? errors.value;
  const hasErrors = Object.keys(errors).length > 0;
  const valuesLabel = kind === 'process' ? text.env : text.headers;

  return (
    <form
      className="setup"
      noValidate
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onCancel();
      }}
    >
      <div className="setup-body">
        <div className="setup-intro">
          <h2 ref={heading} tabIndex={-1}>
            {server === null ? text.newTitle : text.editTitle(server.name)}
          </h2>
        </div>

        <div className="setup-group">
          <Field label={text.name} help={text.nameHelp} error={errors.name}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={40}
                value={name}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <div className="field">
            <label htmlFor={`${ids}-kind`}>{text.kind}</label>
            <select
              id={`${ids}-kind`}
              className="plain"
              value={kind}
              onChange={(event) => setKind(event.target.value === 'http' ? 'http' : 'process')}
            >
              <option value="process">{text.kindProcess}</option>
              <option value="http">{text.kindHttp}</option>
            </select>
          </div>
          {kind === 'process' ? (
            <>
              <Field label={text.command} help={text.commandHelp} error={errors.command}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    className="code"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    value={command}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                )}
              </Field>
              <Field label={text.args} help={text.argsHelp}>
                {({ id, describedBy }) => (
                  <textarea
                    id={id}
                    className="code"
                    rows={3}
                    autoCapitalize="off"
                    spellCheck={false}
                    value={args}
                    aria-describedby={describedBy}
                    onChange={(event) => setArgs(event.target.value)}
                  />
                )}
              </Field>
            </>
          ) : (
            <Field label={text.url} help={text.urlHelp} error={errors.url}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="code"
                  inputMode="url"
                  placeholder="https://example.com/mcp"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={url}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => setUrl(event.target.value)}
                />
              )}
            </Field>
          )}
        </div>

        <fieldset>
          <legend>{valuesLabel}</legend>
          <p className="fieldset-note">{text.valuesHelp}</p>
          {valueNames.length === 0 ? (
            <p className="keys-none">{text.envNone}</p>
          ) : (
            <ul className="keys" aria-label={valuesLabel}>
              {valueNames.map((valueName) => {
                const kept = stored.find((candidate) => candidate.name === valueName);
                const to = changes[valueName];
                const state =
                  to === 'remove'
                    ? text.valueRemoved
                    : to === 'store'
                      ? kept === undefined
                        ? text.valueNew
                        : text.valueReplaced
                      : kept?.stored
                        ? text.valueStored
                        : text.valueEmpty;
                // A kept value is marked for removal; any pending change is taken back.
                const undo = to !== undefined && kept !== undefined;
                const label =
                  to === 'remove'
                    ? text.undoValue(valueName)
                    : undo
                      ? text.undoValueChange(valueName)
                      : text.removeValue(valueName);
                return (
                  <li key={valueName} data-change={to}>
                    <span className="key-name">{valueName}</span>
                    <span className="key-state">{state}</span>
                    <button
                      type="button"
                      className="link"
                      aria-label={label}
                      onClick={() => change(valueName, to === undefined ? 'remove' : undefined)}
                    >
                      {undo ? strings.setup.undo : text.remove}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="key-add">
            <div className="field" data-invalid={errors.valueName === undefined ? undefined : ''}>
              <label htmlFor={`${ids}-value-name`}>
                {kind === 'process' ? text.envName : text.headerName}
              </label>
              <input
                id={`${ids}-value-name`}
                className="code"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={valueName}
                aria-invalid={errors.valueName !== undefined}
                aria-describedby={`${ids}-value-note`}
                onChange={(event) => setValueName(event.target.value)}
              />
            </div>
            <div className="field" data-invalid={errors.value === undefined ? undefined : ''}>
              <label htmlFor={`${ids}-value`}>{text.value}</label>
              <div className="key-add-row">
                <input
                  ref={value}
                  id={`${ids}-value`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={errors.value !== undefined}
                  aria-describedby={`${ids}-value-note`}
                  onKeyDown={(event) => {
                    // Enter in this row adds the value; it must not save the whole form.
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    addValue();
                  }}
                />
                <button type="button" className="button" onClick={addValue}>
                  {text.addValue}
                </button>
              </div>
            </div>
            {valueError !== undefined && (
              <p className="field-note key-add-note" id={`${ids}-value-note`}>
                {valueError}
              </p>
            )}
          </div>
        </fieldset>

        <div className="setup-group">
          <Field label={text.readOnly} help={text.readOnlyHelp}>
            {({ id, describedBy }) => (
              <textarea
                id={id}
                className="code"
                rows={3}
                autoCapitalize="off"
                spellCheck={false}
                value={readOnly}
                aria-describedby={describedBy}
                onChange={(event) => setReadOnly(event.target.value)}
              />
            )}
          </Field>
        </div>
      </div>

      <footer className="setup-footer">
        {rejection !== null && (
          <div className="setup-alert" role="alert">
            <p>{strings.setup.rejected}</p>
            <ErrorBlock label={strings.status.errorDetail}>{rejection}</ErrorBlock>
          </div>
        )}
        <p className="setup-message" role="status" data-kind={hasErrors ? 'error' : 'note'}>
          {hasErrors ? strings.setup.fixFields : text.restartNote}
        </p>
        <div className="setup-actions">
          <button type="button" className="button" disabled={saving} onClick={onCancel}>
            {text.cancel}
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? text.saving : text.save}
          </button>
        </div>
      </footer>
    </form>
  );
}

export function ConnectionsScreen({ load, onSave, onRemove, onClose }: ConnectionsScreenProps) {
  const [view, setView] = useState<ConnectionsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The server in the form: `null` adds one, `undefined` shows the list. */
  const [editing, setEditing] = useState<ConnectionServer | null | undefined>(undefined);
  /** The server whose removal waits for a yes. */
  const [asked, setAsked] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const question = useId();

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

  // The screen replaces the chat, and the list replaces the form: start reading from the title.
  const listed = editing === undefined;
  useEffect(() => {
    if (listed) heading.current?.focus();
  }, [listed]);

  if (editing !== undefined && view !== null) {
    return (
      <ServerForm
        server={editing}
        taken={view.servers.map((server) => server.name).filter((name) => name !== editing?.name)}
        onSave={onSave}
        onSaved={(saved) => {
          setView(saved);
          setEditing(undefined);
        }}
        onCancel={() => setEditing(undefined)}
      />
    );
  }

  const settle = () => {
    setAsked(null);
    // The buttons that had the focus are gone.
    heading.current?.focus();
  };

  const remove = async (name: string) => {
    setRemoving(true);
    setRejection(null);
    try {
      setView(await onRemove(name));
    } catch (error) {
      setRejection(messageOf(error));
    }
    setRemoving(false);
    settle();
  };

  const changeable = view !== null && view.invalid === null;

  return (
    <section
      className="setup"
      aria-labelledby={`${question}-title`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !removing) onClose();
      }}
    >
      <div className="setup-body">
        <div className="setup-intro">
          <h2 ref={heading} id={`${question}-title`} tabIndex={-1}>
            {text.title}
          </h2>
          <p>{text.intro}</p>
        </div>

        <div className="servers">
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
          ) : view.invalid !== null ? (
            <div className="setup-alert" role="alert">
              <p>{text.invalid}</p>
              <ErrorBlock label={strings.status.errorDetail}>{view.invalid}</ErrorBlock>
            </div>
          ) : view.servers.length === 0 ? (
            <p className="keys-none">{text.none}</p>
          ) : (
            <ul className="keys" aria-label={text.servers}>
              {view.servers.map((server) => (
                <li key={server.name}>
                  <span className="key-name">{server.name}</span>
                  <span className="key-state server-target">
                    {server.kind === 'process'
                      ? [server.command, ...server.args].join(' ')
                      : server.url}
                  </span>
                  {asked === server.name ? (
                    <span className="server-confirm">
                      <span id={question}>{text.confirmRemove(server.name)}</span>
                      <button
                        type="button"
                        className="link"
                        aria-describedby={question}
                        disabled={removing}
                        onClick={() => remove(server.name)}
                      >
                        {removing ? text.removing : text.confirmRemoveYes}
                      </button>
                      <button
                        type="button"
                        className="link"
                        aria-describedby={question}
                        // biome-ignore lint/a11y/noAutofocus: the button it replaces had the focus.
                        autoFocus
                        disabled={removing}
                        onClick={settle}
                      >
                        {text.keepServer}
                      </button>
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="link"
                        aria-label={text.editServer(server.name)}
                        onClick={() => setEditing(server)}
                      >
                        {text.edit}
                      </button>
                      <button
                        type="button"
                        className="link"
                        aria-label={text.removeServer(server.name)}
                        onClick={() => {
                          setRejection(null);
                          setAsked(server.name);
                        }}
                      >
                        {text.remove}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <footer className="setup-footer">
        {rejection !== null && (
          <div className="setup-alert" role="alert">
            <p>{text.removeRejected}</p>
            <ErrorBlock label={strings.status.errorDetail}>{rejection}</ErrorBlock>
          </div>
        )}
        <div className="setup-actions">
          <button type="button" className="button" onClick={onClose}>
            {text.close}
          </button>
          {changeable && (
            <button type="button" className="button primary" onClick={() => setEditing(null)}>
              {text.add}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
