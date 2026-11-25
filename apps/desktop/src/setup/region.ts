// DK-25 AC5: the time zone and the currency the setup proposes while none is stored: this
// system's zone, and the currency of its region (`EUR` when the region is not one listed here).
import { DEFAULT_CURRENCY, isCurrency } from '@anomander/protocol';

/** The currencies offered by name in Configuración; any other is typed as its ISO 4217 code. */
export const COMMON_CURRENCIES = [
  'EUR',
  'USD',
  'GBP',
  'MXN',
  'ARS',
  'COP',
  'CLP',
  'PEN',
  'BRL',
  'CHF',
] as const;

/** The regions of the euro, then other regions by their currency. */
const EURO = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK AD MC SM VA ME XK';
const BY_REGION: Record<string, string> = {
  ...Object.fromEntries(EURO.split(' ').map((region) => [region, 'EUR'])),
  US: 'USD',
  PR: 'USD',
  EC: 'USD',
  SV: 'USD',
  PA: 'USD',
  GB: 'GBP',
  MX: 'MXN',
  AR: 'ARS',
  CO: 'COP',
  CL: 'CLP',
  PE: 'PEN',
  UY: 'UYU',
  BO: 'BOB',
  PY: 'PYG',
  VE: 'VES',
  GT: 'GTQ',
  CR: 'CRC',
  DO: 'DOP',
  BR: 'BRL',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  CH: 'CHF',
  LI: 'CHF',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  PL: 'PLN',
  CZ: 'CZK',
  HU: 'HUF',
  RO: 'RON',
  JP: 'JPY',
  CN: 'CNY',
  IN: 'INR',
};

/** The currency of the region of `language` (`es-MX` → `MXN`); `EUR` without a known one. */
export const currencyOfLanguage = (language: string | undefined): string => {
  try {
    const region = new Intl.Locale(language ?? '').maximize().region;
    const currency = region === undefined ? undefined : BY_REGION[region];
    return currency !== undefined && isCurrency(currency) ? currency : DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
};

/** The time zone this system's clock is in, as the window's `Intl` reads it. */
export const systemTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Every IANA zone this window knows, with `current` among them even when it is not listed. */
export const timeZones = (current: string): string[] => {
  const known = Intl.supportedValuesOf('timeZone');
  return known.includes(current) ? known : [current, ...known];
};

/** The value of an ISO 4217 code as typed: trimmed, in upper case. */
export const currencyCode = (typed: string): string => typed.trim().toUpperCase();
