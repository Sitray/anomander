// DK-5 AC1: the setup screen. Presentational: the stored setup in, a `SetupInput` out.
//
// Secrets (the bot token, the provider keys) are typed into uncontrolled fields and kept in a
// ref, so they never enter React state or a DOM attribute, and they are dropped once saved.
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { SetupInput, SetupState } from '../shell.ts';
import { ErrorBlock } from '../status/StatusBar.tsx';
import { strings } from '../strings.ts';
import { messageOf } from '../ui/message-of.ts';
import { isChatId, isModelId, isProviderKeyName, KNOWN_PROVIDER_KEYS } from './validation.ts';

export interface SetupScreenProps {
  setup: SetupState;
  /** Saves and resolves with the setup now stored; rejects with the shell's own message. */
  onSave: (input: SetupInput) => Promise<SetupState>;
  onClose: () => void;
}

const { setup: text } = strings;
const OTHER = 'other';

type FieldName = 'chatId' | 'model' | 'visionModel' | 'keyName' | 'keyValue';
type Errors = Partial<Record<FieldName, string>>;
/** What saving will do to a provider key. */
type KeyChange = 'store' | 'remove';

interface FieldProps {
  label: string;
  help: string;
  error?: string | undefined;
  children: (ids: { id: string; describedBy: string; invalid: boolean }) => ReactNode;
}

/** A label, its control, and under it the help or, instead, what is wrong. */
function Field({ label, help, error, children }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className="field" data-invalid={error === undefined ? undefined : ''}>
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy: noteId, invalid: error !== undefined })}
      <p className="field-note" id={noteId}>
        {error ?? help}
      </p>
    </div>
  );
}

const isComplete = (setup: SetupState): boolean =>
  setup.hasTelegramBotToken && setup.principalChatId !== null;

interface FormProps extends SetupScreenProps {
  /** The setup was saved and still cannot start the daemon. */
  incomplete: boolean;
  onSaved: (setup: SetupState) => void;
}

function SetupForm({ setup, incomplete, onSave, onSaved, onClose }: FormProps) {
  const [chatId, setChatId] = useState(setup.principalChatId ?? '');
  const [model, setModel] = useState(setup.model ?? '');
  const [visionModel, setVisionModel] = useState(setup.visionModel ?? '');
  const [provider, setProvider] = useState<string>(KNOWN_PROVIDER_KEYS[0]);
  const [keyName, setKeyName] = useState('');
  const [changes, setChanges] = useState<Record<string, KeyChange>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  const botToken = useRef<HTMLInputElement>(null);
  const keyValue = useRef<HTMLInputElement>(null);
  /** The keys to store, by variable name. Never rendered. */
  const typedKeys = useRef(new Map<string, string>());
  const heading = useRef<HTMLHeadingElement>(null);

  // The screen replaces the chat: start reading it from its title.
  useEffect(() => heading.current?.focus(), []);

  const change = (name: string, to: KeyChange | undefined) => {
    setChanges(({ [name]: _dropped, ...rest }) =>
      to === undefined ? rest : { ...rest, [name]: to },
    );
    if (to !== 'store') typedKeys.current.delete(name);
  };

  /**
   * Takes the key typed in the "add" row, when there is one. Returns what is wrong with it, or
   * `null` when it was taken or the row is empty.
   */
  const takeTypedKey = (required: boolean): Errors | null => {
    const name = provider === OTHER ? keyName.trim().toUpperCase() : provider;
    const value = keyValue.current?.value.trim() ?? '';
    const untouched = value === '' && (provider !== OTHER || name === '');
    if (untouched && !required) return null;
    if (!isProviderKeyName(name)) return { keyName: text.keyNameInvalid };
    if (value === '') return { keyValue: text.keyValueMissing };
    typedKeys.current.set(name, value);
    change(name, 'store');
    if (keyValue.current !== null) keyValue.current.value = '';
    setKeyName('');
    return null;
  };

  const addKey = () => {
    const wrong = takeTypedKey(true);
    setErrors(({ keyName: _name, keyValue: _value, ...rest }) => ({ ...rest, ...wrong }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const input: SetupInput = {
      principalChatId: chatId.trim(),
      model: model.trim(),
      visionModel: visionModel.trim(),
      providerKeys: {},
    };
    const wrong: Errors = {
      ...(isChatId(input.principalChatId) ? {} : { chatId: text.chatIdInvalid }),
      ...(isModelId(input.model) ? {} : { model: text.modelInvalid }),
      ...(isModelId(input.visionModel) ? {} : { visionModel: text.modelInvalid }),
      // A key typed but not added is still meant to be saved.
      ...takeTypedKey(false),
    };
    setErrors(wrong);
    setRejection(null);
    if (Object.keys(wrong).length > 0) return;

    // Read after `takeTypedKey`, whose `change` has not reached `changes` yet.
    for (const [name, to] of Object.entries(changes)) {
      if (to === 'remove') input.providerKeys[name] = null;
    }
    for (const [name, value] of typedKeys.current) input.providerKeys[name] = value;
    // Omitted keeps the stored token.
    const token = botToken.current?.value.trim() ?? '';
    if (token !== '') input.telegramBotToken = token;

    setSaving(true);
    try {
      const saved = await onSave(input);
      typedKeys.current.clear();
      onSaved(saved);
    } catch (error) {
      setRejection(messageOf(error));
      setSaving(false);
    }
  };

  const keyNames = [
    ...setup.providerKeys,
    ...Object.keys(changes).filter((name) => !setup.providerKeys.includes(name)),
  ];
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <form
      className="setup"
      noValidate
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onClose();
      }}
    >
      <div className="setup-body">
        <div className="setup-intro">
          <h2 ref={heading} tabIndex={-1}>
            {text.title}
          </h2>
          <p>{text.intro}</p>
        </div>

        <fieldset>
          <legend>{text.sectionTelegram}</legend>
          <Field label={text.botToken} help={text.botTokenHelp}>
            {({ id, describedBy }) => (
              <input
                ref={botToken}
                id={id}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={setup.hasTelegramBotToken ? text.botTokenStored : ''}
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <Field label={text.chatId} help={text.chatIdHelp} error={errors.chatId}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={chatId}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => setChatId(event.target.value)}
              />
            )}
          </Field>
        </fieldset>

        <fieldset>
          <legend>{text.sectionModels}</legend>
          <Field label={text.model} help={text.modelHelp} error={errors.model}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="code"
                placeholder={text.modelExample}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={model}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => setModel(event.target.value)}
              />
            )}
          </Field>
          <Field label={text.visionModel} help={text.visionModelHelp} error={errors.visionModel}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="code"
                placeholder={text.modelExample}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={visionModel}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => setVisionModel(event.target.value)}
              />
            )}
          </Field>
        </fieldset>

        <fieldset>
          <legend>{text.keys}</legend>
          <p className="fieldset-note">{text.keysHelp}</p>
          {keyNames.length === 0 ? (
            <p className="keys-none">{text.keysNone}</p>
          ) : (
            <ul className="keys" aria-label={text.keys}>
              {keyNames.map((name) => {
                const stored = setup.providerKeys.includes(name);
                const to = changes[name];
                const state =
                  to === 'remove'
                    ? text.keyRemoved
                    : to === 'store'
                      ? stored
                        ? text.keyReplaced
                        : text.keyNew
                      : text.keyStored;
                // A stored key is marked for removal; any pending change is taken back.
                const undo = to !== undefined && stored;
                const label =
                  to === 'remove'
                    ? text.undoKey(name)
                    : undo
                      ? text.undoKeyChange(name)
                      : text.removeKey(name);
                return (
                  <li key={name} data-change={to}>
                    <span className="key-name">{name}</span>
                    <span className="key-state">{state}</span>
                    <button
                      type="button"
                      className="link"
                      aria-label={label}
                      onClick={() => change(name, to === undefined ? 'remove' : undefined)}
                    >
                      {undo ? text.undo : text.remove}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="key-add">
            <div className="field">
              <label htmlFor="setup-provider">{text.provider}</label>
              <select
                id="setup-provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                {KNOWN_PROVIDER_KEYS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                <option value={OTHER}>{text.otherProvider}</option>
              </select>
            </div>
            {provider === OTHER && (
              <div className="field" data-invalid={errors.keyName === undefined ? undefined : ''}>
                <label htmlFor="setup-key-name">{text.keyName}</label>
                <input
                  id="setup-key-name"
                  className="code"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="MISTRAL_API_KEY"
                  value={keyName}
                  aria-invalid={errors.keyName !== undefined}
                  aria-describedby="setup-key-note"
                  onChange={(event) => setKeyName(event.target.value)}
                />
              </div>
            )}
            <div className="field" data-invalid={errors.keyValue === undefined ? undefined : ''}>
              <label htmlFor="setup-key-value">{text.keyValue}</label>
              <div className="key-add-row">
                <input
                  ref={keyValue}
                  id="setup-key-value"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={errors.keyValue !== undefined}
                  aria-describedby="setup-key-note"
                  onKeyDown={(event) => {
                    // Enter in this row adds the key; it must not save the whole form.
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    addKey();
                  }}
                />
                <button type="button" className="button" onClick={addKey}>
                  {text.addKey}
                </button>
              </div>
            </div>
            {(errors.keyName ?? errors.keyValue) !== undefined && (
              <p className="field-note key-add-note" id="setup-key-note">
                {errors.keyName ?? errors.keyValue}
              </p>
            )}
          </div>
        </fieldset>
      </div>

      <footer className="setup-footer">
        {rejection !== null && (
          <div className="setup-alert" role="alert">
            <p>{text.rejected}</p>
            <ErrorBlock label={strings.status.errorDetail}>{rejection}</ErrorBlock>
          </div>
        )}
        <p className="setup-message" role="status" data-kind={hasErrors ? 'error' : 'note'}>
          {hasErrors ? text.fixFields : incomplete ? text.savedIncomplete : ''}
        </p>
        <div className="setup-actions">
          <button type="button" className="button" onClick={onClose}>
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

export function SetupScreen({ setup, onSave, onClose }: SetupScreenProps) {
  // After a save the form starts over from what was stored, with every secret field empty.
  const [stored, setStored] = useState({ setup, saves: 0 });
  return (
    <SetupForm
      key={stored.saves}
      setup={stored.setup}
      incomplete={stored.saves > 0 && !isComplete(stored.setup)}
      onSave={onSave}
      onClose={onClose}
      onSaved={(saved) => setStored({ setup: saved, saves: stored.saves + 1 })}
    />
  );
}
