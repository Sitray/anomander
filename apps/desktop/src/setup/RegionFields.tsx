// DK-25 AC5: the time zone and the currency, in the setup. Presentational: the values in, each
// change out. An empty value is "not chosen": the machine's zone, and the daemon's `EUR`. The
// currency is one of a short list or any ISO 4217 code with cents typed under "Otra".
import { DEFAULT_CURRENCY } from '@anomander/protocol';
import { useId } from 'react';
import { strings } from '../strings.ts';
import { COMMON_CURRENCIES, timeZones } from './region.ts';
import { Field } from './SetupScreen.tsx';

export interface Region {
  /** An IANA zone; empty follows the machine's clock. */
  timeZone: string;
  /** An ISO 4217 code; empty is the daemon's default, `EUR`. */
  currency: string;
  /** "Otra" is chosen: `currency` is what is typed. */
  typed: boolean;
}

const OTHER = 'other';

export function RegionFields({
  value,
  currencyError,
  onChange,
}: {
  value: Region;
  currencyError: string | undefined;
  onChange: (value: Region) => void;
}) {
  const text = strings.region;
  const otherId = useId();
  const listed = value.currency === '' ? DEFAULT_CURRENCY : value.currency;
  return (
    <fieldset>
      <legend>{text.section}</legend>
      <p className="fieldset-note">{text.help}</p>
      <Field label={text.timeZone} help={text.timeZoneHelp}>
        {({ id, describedBy }) => (
          <select
            id={id}
            value={value.timeZone}
            aria-describedby={describedBy}
            onChange={(event) => onChange({ ...value, timeZone: event.target.value })}
          >
            <option value="">{text.machineZone}</option>
            {timeZones(value.timeZone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={text.currency} help={text.currencyHelp}>
        {({ id, describedBy }) => (
          <select
            id={id}
            value={value.typed ? OTHER : listed}
            aria-describedby={describedBy}
            onChange={(event) => {
              const typed = event.target.value === OTHER;
              onChange({ ...value, typed, currency: typed ? '' : event.target.value });
            }}
          >
            {COMMON_CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
            <option value={OTHER}>{text.otherCurrency}</option>
          </select>
        )}
      </Field>
      {value.typed && (
        <div className="field" data-invalid={currencyError === undefined ? undefined : ''}>
          <label htmlFor={otherId}>{text.currencyCode}</label>
          <input
            id={otherId}
            className="code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={3}
            placeholder="SEK"
            value={value.currency}
            aria-invalid={currencyError !== undefined}
            aria-describedby={`${otherId}-note`}
            onChange={(event) => onChange({ ...value, currency: event.target.value })}
          />
          <p className="field-note" id={`${otherId}-note`}>
            {currencyError ?? text.currencyCodeHelp}
          </p>
        </div>
      )}
    </fieldset>
  );
}
