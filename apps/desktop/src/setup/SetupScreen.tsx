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
  /** DK-12: opens the import of a ledger brought from a Docker install. */
  onOpenLedger?: () => void;
  /** DK-15: opens the subscriptions screen, from the models section. */
  onOpenSubscriptions?: () => void;
  /**
   * DK-11 AC11: adds the web search connection; `true` when it was saved, `false` when a server
   * already had its name. Rejects with the shell's own message. Offered, checked, on the first
   * setup only.
   */
  onAddWebSearch?: () => Promise<boolean>;
  /** DK-21: today's AI calls and the daily limit (R-12); absent or `null` until the daemon said. */
  aiUsage?: { calls: number; limit: number } | null;
}

const { setup: text } = strings;
const OTHER = 'other';
/** DK-21: the daily limit of AI calls the shell takes, as typed: a whole number from 1 to 10000. */
const aiLimitOf = (typed: string): number | undefined => {
  const limit = /^\d{1,5}$/.test(typed) ? Number(typed) : Number.NaN;
  return limit >= 1 && limit <= 10_000 ? limit : undefined;
};

type FieldName =
  | 'botToken'
  | 'chatId'
  | 'model'
  | 'visionModel'
  | 'keyName'
  | 'keyValue'
  | 'aiLimit';
type Errors = Partial<Record<FieldName, string>>;
/** What saving will do to a provider key. */
type KeyChange = 'store' | 'remove';

interface FieldProps {
  label: string;
  help: string;
  error?: string | undefined;
  /** S5: said beside the label, for a field the daemon cannot start without. */
  required?: boolean;
  children: (ids: { id: string; describedBy: string; invalid: boolean }) => ReactNode;
}

/** A label, its control, and under it the help or, instead, what is wrong. */
export function Field({ label, help, error, required, children }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const requiredId = `${id}-required`;
  return (
    <div className="field" data-invalid={error === undefined ? undefined : ''}>
      {required === true ? (
        <div className="field-head">
          <label htmlFor={id}>{label}</label>
          {/* Beside the label, not in it, so the label stays the field's name; described instead. */}
          <span className="field-required" id={requiredId}>
            {text.required}
          </span>
        </div>
      ) : (
        <label htmlFor={id}>{label}</label>
      )}
      {children({
        id,
        describedBy: required === true ? `${noteId} ${requiredId}` : noteId,
        invalid: error !== undefined,
      })}
      <p className="field-note" id={noteId}>
        {error ?? help}
      </p>
    </div>
  );
}

/**
 * Whether the stored setup can start the daemon, as the shell decides: a model for the chat, or
 * Telegram whole (T13), whose setup guide and `/login` need no model.
 */
export const isComplete = (setup: SetupState): boolean =>
  setup.model !== null || (setup.hasTelegramBotToken && setup.principalChatId !== null);

interface FormProps extends SetupScreenProps {
  /** The setup was saved and still cannot start the daemon. */
  incomplete: boolean;
  onSaved: (setup: SetupState) => void;
}

function SetupForm(props: FormProps) {
  const { setup, incomplete, onSave, onSaved, onClose, onOpenLedger, onOpenSubscriptions } = props;
  const { onAddWebSearch } = props;
  const [chatId, setChatId] = useState(setup.principalChatId ?? '');
  const [model, setModel] = useState(setup.model ?? '');
  const [visionModel, setVisionModel] = useState(setup.visionModel ?? '');
  /** DK-21: empty keeps the stored limit. */
  const [aiLimit, setAiLimit] = useState('');
  const [provider, setProvider] = useState<string>(KNOWN_PROVIDER_KEYS[0]);
  const [keyName, setKeyName] = useState('');
  const [changes, setChanges] = useState<Record<string, KeyChange>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  /** The web search was saved on this screen: a setup refused after it does not undo it. */
  const [webSearchKept, setWebSearchKept] = useState(false);

  const botToken = useRef<HTMLInputElement>(null);
  const keyValue = useRef<HTMLInputElement>(null);
  /** The keys to store, by variable name. Never rendered. */
  const typedKeys = useRef(new Map<string, string>());
  const heading = useRef<HTMLHeadingElement>(null);

  // The screen replaces the chat: start reading it from its title.
  useEffect(() => heading.current?.focus(), []);

  // S5: until the setup can start the daemon, the chat needs a model. Telegram is optional (T13):
  // both its fields, or neither. A stored token may stay blank to keep it, and an empty chat ID
  // means "unset", as the shell takes it.
  const modelRequired = !isComplete(setup);
  // On the first setup the web search comes checked, with what leaves the Mac beside it.
  const offersWebSearch = modelRequired && onAddWebSearch !== undefined;
  const [webSearch, setWebSearch] = useState(true);
  const webSearchId = useId();

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
    // Omitted keeps the stored token.
    const token = botToken.current?.value.trim() ?? '';
    const hasToken = token !== '' || setup.hasTelegramBotToken;
    const hasChatId = input.principalChatId !== '';
    const wrong: Errors = {
      // T13: half of Telegram is refused, as the shell does; a stored token counts as typed.
      ...(hasChatId && !hasToken ? { botToken: text.botTokenMissing } : {}),
      ...(!hasChatId && token !== ''
        ? { chatId: text.chatIdMissing }
        : isChatId(input.principalChatId)
          ? {}
          : { chatId: text.chatIdInvalid }),
      // S5: what the daemon cannot start without is asked for while it is not stored.
      ...(modelRequired && input.model === '' && !(hasChatId && hasToken)
        ? { model: text.modelMissing }
        : isModelId(input.model)
          ? {}
          : { model: text.modelInvalid }),
      ...(isModelId(input.visionModel) ? {} : { visionModel: text.modelInvalid }),
      ...(aiLimit.trim() === '' || aiLimitOf(aiLimit.trim()) !== undefined
        ? {}
        : { aiLimit: text.aiLimitInvalid }),
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
    if (token !== '') input.telegramBotToken = token;
    const limit = aiLimitOf(aiLimit.trim());
    if (limit !== undefined) input.dailyAiCallLimit = limit;

    setSaving(true);
    try {
      // Before the setup: saving it starts the daemon, and saving a connection would restart it.
      // Only a server this save added is said to stay on: one already there was the principal's.
      if (offersWebSearch && webSearch && (await onAddWebSearch())) setWebSearchKept(true);
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
          {onOpenLedger !== undefined && (
            <button type="button" className="link" onClick={onOpenLedger}>
              {strings.ledger.open}
            </button>
          )}
        </div>

        <fieldset>
          <legend>{text.sectionTelegram}</legend>
          <Field label={text.botToken} help={text.botTokenHelp} error={errors.botToken}>
            {({ id, describedBy, invalid }) => (
              <input
                ref={botToken}
                id={id}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={setup.hasTelegramBotToken ? text.botTokenStored : ''}
                aria-describedby={describedBy}
                aria-invalid={invalid}
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
          <Field
            label={text.model}
            help={text.modelHelp}
            error={errors.model}
            required={modelRequired}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="code"
                placeholder={text.modelPlaceholder}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={model}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                aria-required={modelRequired}
                onChange={(event) => setModel(event.target.value)}
              />
            )}
          </Field>
          <Field label={text.visionModel} help={text.visionModelHelp} error={errors.visionModel}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="code"
                placeholder={text.modelPlaceholder}
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
          {onOpenSubscriptions !== undefined && (
            <p className="fieldset-note">
              <button type="button" className="link" onClick={onOpenSubscriptions}>
                {strings.subscriptions.open}
              </button>
            </p>
          )}
          {props.aiUsage != null && (
            <p className="fieldset-note">
              {text.aiUsage(props.aiUsage.calls, props.aiUsage.limit)}
            </p>
          )}
          <Field label={text.aiLimit} help={text.aiLimitHelp} error={errors.aiLimit}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                placeholder={props.aiUsage == null ? '' : String(props.aiUsage.limit)}
                value={aiLimit}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => setAiLimit(event.target.value)}
              />
            )}
          </Field>
        </fieldset>

        {offersWebSearch && (
          <fieldset>
            <legend>{strings.connections.webSearch}</legend>
            <div className="field">
              <label className="check" htmlFor={webSearchId}>
                <input
                  id={webSearchId}
                  type="checkbox"
                  checked={webSearch}
                  aria-describedby={`${webSearchId}-note`}
                  onChange={(event) => setWebSearch(event.target.checked)}
                />
                {text.webSearch}
              </label>
              <p className="field-note" id={`${webSearchId}-note`}>
                {strings.connections.webSearchNote}
              </p>
            </div>
          </fieldset>
        )}

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
            {webSearchKept && <p>{text.webSearchKept}</p>}
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

export function SetupScreen(props: SetupScreenProps) {
  const { setup, onSave, onClose, onOpenLedger, onOpenSubscriptions, onAddWebSearch } = props;
  const { aiUsage } = props;
  // After a save the form starts over from what was stored, with every secret field empty.
  const [stored, setStored] = useState({ setup, saves: 0 });
  return (
    <SetupForm
      key={stored.saves}
      setup={stored.setup}
      incomplete={stored.saves > 0 && !isComplete(stored.setup)}
      onSave={onSave}
      onClose={onClose}
      {...(onOpenLedger === undefined ? {} : { onOpenLedger })}
      {...(onOpenSubscriptions === undefined ? {} : { onOpenSubscriptions })}
      {...(onAddWebSearch === undefined ? {} : { onAddWebSearch })}
      {...(aiUsage === undefined ? {} : { aiUsage })}
      onSaved={(saved) => setStored({ setup: saved, saves: stored.saves + 1 })}
    />
  );
}
