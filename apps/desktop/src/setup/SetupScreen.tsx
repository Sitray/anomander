// DK-5 AC1: the setup screen. Secrets are typed into uncontrolled fields and read only when
// they are added or saved; once saved they are dropped. The shell never sends one back, only
// whether it is stored.
import { type FormEvent, type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import type { SetupInput, SetupState } from '../shell.ts';
import { strings } from '../strings.ts';
import { BackIcon } from '../ui/icons.tsx';

export interface SetupScreenProps {
  setup: SetupState;
  /** Resolves with whether the shell saved it. */
  onSave: (input: SetupInput) => Promise<boolean>;
  onBack: () => void;
}

export const KNOWN_KEY_VARIABLES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

const CHAT_ID = /^\d+$/;
const MODEL = /^[^/\s]+\/\S+$/;
const KEY_VARIABLE = /^[A-Z][A-Z0-9_]*_API_KEY$/;
/** The select's value for "type another variable". */
const OTHER = '';

type Field = 'botToken' | 'chatId' | 'model' | 'visionModel' | 'keyVariable' | 'keyValue';
type Errors = Partial<Record<Field, string>>;

const modelError = (value: string): string | undefined =>
  value === '' || MODEL.test(value) ? undefined : strings.modelInvalid;

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error: string | undefined;
  children: (describedBy: string | undefined) => ReactNode;
}

const FormField = ({ id, label, hint, error, children }: FieldProps) => {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field" data-invalid={error !== undefined || undefined}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(describedBy)}
      {error !== undefined && (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      )}
      {hint !== undefined && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
};

export const SetupScreen = ({ setup, onSave, onBack }: SetupScreenProps) => {
  const id = useId();
  const [chatId, setChatId] = useState(setup.principalChatId ?? '');
  const [model, setModel] = useState(setup.model ?? '');
  const [visionModel, setVisionModel] = useState(setup.visionModel ?? '');
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  /** Names of the keys added in this visit; their values live in `addedValues`, never in state. */
  const [added, setAdded] = useState<readonly string[]>([]);
  const addedValues = useRef(new Map<string, string>());
  const [variable, setVariable] = useState<string>(KNOWN_KEY_VARIABLES[0]);
  const [customVariable, setCustomVariable] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const botToken = useRef<HTMLInputElement>(null);
  const keyValue = useRef<HTMLInputElement>(null);

  const fieldId = (field: Field | 'keyVariableCustom') => `${id}-${field}`;
  const stored = setup.providerKeys.filter((name) => !added.includes(name));

  /** The key typed in the "add" row, validated; `null` when nothing was typed. */
  const typedKey = (): { name: string; value: string } | { error: Errors } | null => {
    const value = keyValue.current?.value.trim() ?? '';
    if (value === '') return null;
    const name = variable === OTHER ? customVariable.trim() : variable;
    if (!KEY_VARIABLE.test(name)) return { error: { keyVariable: strings.keyVariableInvalid } };
    return { name, value };
  };

  const focusFirstInvalid = (found: Errors) => {
    const first = (Object.keys(found) as Field[])[0];
    if (first === undefined) return;
    const target = first === 'keyVariable' && variable === OTHER ? 'keyVariableCustom' : first;
    form.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${target}`)}`)?.focus();
  };

  const addKey = () => {
    const typed = typedKey();
    if (typed === null) {
      setErrors({ keyValue: strings.keyValueRequired });
      return;
    }
    if ('error' in typed) {
      setErrors(typed.error);
      return;
    }
    addedValues.current.set(typed.name, typed.value);
    setAdded((current) => [...current.filter((name) => name !== typed.name), typed.name]);
    setRemoved((current) => new Set([...current].filter((name) => name !== typed.name)));
    if (keyValue.current !== null) keyValue.current.value = '';
    setCustomVariable('');
    setErrors({});
  };

  const dropAdded = (name: string) => {
    addedValues.current.delete(name);
    setAdded((current) => current.filter((candidate) => candidate !== name));
  };

  const toggleRemoved = (name: string) =>
    setRemoved((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  /** Drops every secret typed in this visit. */
  const forgetSecrets = () => {
    if (botToken.current !== null) botToken.current.value = '';
    if (keyValue.current !== null) keyValue.current.value = '';
    addedValues.current.clear();
    setAdded([]);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const token = botToken.current?.value.trim() ?? '';
    const typed = typedKey();
    const found: Errors = {
      ...(!setup.hasTelegramBotToken && token === '' ? { botToken: strings.botTokenRequired } : {}),
      ...(CHAT_ID.test(chatId.trim()) ? {} : { chatId: strings.chatIdInvalid }),
      ...(modelError(model.trim()) === undefined ? {} : { model: strings.modelInvalid }),
      ...(modelError(visionModel.trim()) === undefined
        ? {}
        : { visionModel: strings.modelInvalid }),
      ...(typed !== null && 'error' in typed ? typed.error : {}),
    };
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(found);
      return;
    }
    const providerKeys: Record<string, string | null> = {};
    for (const name of removed) providerKeys[name] = null;
    for (const [name, value] of addedValues.current) providerKeys[name] = value;
    if (typed !== null && !('error' in typed)) providerKeys[typed.name] = typed.value;
    const input: SetupInput = {
      principalChatId: chatId.trim(),
      model: model.trim(),
      visionModel: visionModel.trim(),
      providerKeys,
      ...(token === '' ? {} : { telegramBotToken: token }),
    };
    setSaving(true);
    setFailed(false);
    // The input is the last holder of the secrets: once handed over, they are forgotten here.
    forgetSecrets();
    const saved = await onSave(input);
    setSaving(false);
    if (saved) setRemoved(new Set());
    else setFailed(true);
  };

  /** Enter in the "add a key" row adds the key instead of saving the whole form. */
  const addOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addKey();
  };

  return (
    <main className="setup">
      <form ref={form} className="setup-form" noValidate onSubmit={onSubmit}>
        <div className="setup-header">
          <button type="button" className="link-button" onClick={onBack}>
            <BackIcon />
            {strings.back}
          </button>
          <h1 className="setup-title">{strings.setupTitle}</h1>
        </div>
        <div className="setup-body">
          <p className="setup-intro">{strings.setupIntro}</p>

          <fieldset className="group">
            <legend className="visually-hidden">{strings.telegramGroup}</legend>
            <FormField
              id={fieldId('botToken')}
              label={strings.botTokenLabel}
              hint={setup.hasTelegramBotToken ? strings.botTokenStored : strings.botTokenHint}
              error={errors.botToken}
            >
              {(describedBy) => (
                <input
                  ref={botToken}
                  id={fieldId('botToken')}
                  className="input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={setup.hasTelegramBotToken ? '••••••••••' : '123456:ABC-DEF…'}
                  aria-describedby={describedBy}
                  aria-invalid={errors.botToken !== undefined || undefined}
                />
              )}
            </FormField>
            <FormField
              id={fieldId('chatId')}
              label={strings.chatIdLabel}
              hint={strings.chatIdHint}
              error={errors.chatId}
            >
              {(describedBy) => (
                <input
                  id={fieldId('chatId')}
                  className="input input--numeric"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  value={chatId}
                  onChange={(event) => setChatId(event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={errors.chatId !== undefined || undefined}
                />
              )}
            </FormField>
          </fieldset>

          <fieldset className="group">
            <legend className="visually-hidden">{strings.modelsGroup}</legend>
            <FormField
              id={fieldId('model')}
              label={strings.modelLabel}
              hint={strings.modelHint}
              error={errors.model}
            >
              {(describedBy) => (
                <input
                  id={fieldId('model')}
                  className="input input--mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="openai/gpt-4o-mini"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={errors.model !== undefined || undefined}
                />
              )}
            </FormField>
            <FormField
              id={fieldId('visionModel')}
              label={strings.visionModelLabel}
              hint={strings.visionModelHint}
              error={errors.visionModel}
            >
              {(describedBy) => (
                <input
                  id={fieldId('visionModel')}
                  className="input input--mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="openai/gpt-4o-mini"
                  value={visionModel}
                  onChange={(event) => setVisionModel(event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={errors.visionModel !== undefined || undefined}
                />
              )}
            </FormField>
          </fieldset>

          <fieldset className="group">
            <legend className="group-title">{strings.keysTitle}</legend>
            {stored.length === 0 && added.length === 0 ? (
              <p className="keys-empty">{strings.keysEmpty}</p>
            ) : (
              // biome-ignore lint/a11y/noRedundantRoles: WebKit drops list semantics without it
              <ul className="keys" role="list">
                {stored.map((name) => {
                  const removing = removed.has(name);
                  return (
                    <li key={name} className="key" data-removing={removing || undefined}>
                      <code className="key-name">{name}</code>
                      <span className="key-state">
                        {removing ? strings.keyRemoved : strings.keyStored}
                      </span>
                      <button
                        type="button"
                        className="link-button"
                        aria-label={
                          removing ? strings.undoRemoveKey(name) : strings.removeKey(name)
                        }
                        onClick={() => toggleRemoved(name)}
                      >
                        {removing ? strings.undo : strings.remove}
                      </button>
                    </li>
                  );
                })}
                {added.map((name) => (
                  <li key={name} className="key" data-new>
                    <code className="key-name">{name}</code>
                    <span className="key-state">{strings.keyNew}</span>
                    <button
                      type="button"
                      className="link-button"
                      aria-label={strings.removeKey(name)}
                      onClick={() => dropAdded(name)}
                    >
                      {strings.remove}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="key-add">
              <div className="field">
                <label className="field-label" htmlFor={fieldId('keyVariable')}>
                  {strings.keyVariableLabel}
                </label>
                <select
                  id={fieldId('keyVariable')}
                  className="input select"
                  value={variable}
                  onChange={(event) => setVariable(event.target.value)}
                  aria-describedby={
                    errors.keyVariable === undefined ? undefined : `${fieldId('keyVariable')}-error`
                  }
                >
                  {KNOWN_KEY_VARIABLES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  <option value={OTHER}>{strings.keyVariableOther}</option>
                </select>
              </div>
              {variable === OTHER && (
                <div className="field">
                  <label className="field-label" htmlFor={fieldId('keyVariableCustom')}>
                    {strings.keyVariableCustomLabel}
                  </label>
                  <input
                    id={fieldId('keyVariableCustom')}
                    className="input input--mono"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="characters"
                    placeholder="MISTRAL_API_KEY"
                    value={customVariable}
                    onChange={(event) => setCustomVariable(event.target.value.toUpperCase())}
                    onKeyDown={addOnEnter}
                    aria-invalid={errors.keyVariable !== undefined || undefined}
                  />
                </div>
              )}
              <div className="field">
                <label className="field-label" htmlFor={fieldId('keyValue')}>
                  {strings.keyValueLabel}
                </label>
                <div className="key-value-row">
                  <input
                    ref={keyValue}
                    id={fieldId('keyValue')}
                    className="input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    onKeyDown={addOnEnter}
                    aria-invalid={errors.keyValue !== undefined || undefined}
                    aria-describedby={
                      errors.keyValue === undefined ? undefined : `${fieldId('keyValue')}-error`
                    }
                  />
                  <button type="button" className="button" onClick={addKey}>
                    {strings.addKey}
                  </button>
                </div>
              </div>
              {errors.keyVariable !== undefined && (
                <p className="field-error" id={`${fieldId('keyVariable')}-error`}>
                  {errors.keyVariable}
                </p>
              )}
              {errors.keyValue !== undefined && (
                <p className="field-error" id={`${fieldId('keyValue')}-error`}>
                  {errors.keyValue}
                </p>
              )}
            </div>
          </fieldset>
        </div>
        <div className="setup-footer">
          {failed && (
            <p className="field-error" role="alert">
              {strings.saveFailed}
            </p>
          )}
          <button type="submit" className="button button--primary" disabled={saving}>
            {saving ? strings.saving : strings.save}
          </button>
        </div>
      </form>
    </main>
  );
};
