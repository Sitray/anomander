// PRD §12: every user-facing string, verbatim (`es-ES`). Nothing else may build bot text.

const amountFormat = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const dateFormat = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** `2340` → `23,40 €`. */
export const formatAmount = (cents: number): string => amountFormat.format(cents / 100);

/** `2026-10-29` → `29 de octubre`. */
export const formatDate = (isoDate: string): string =>
  dateFormat.format(new Date(`${isoDate}T00:00:00Z`));

/** R-25 AC11: `9:00 → a las 9:00`, but `1:00 → a la 1:00`. `time` is `HH:mm`. */
const atTime = (time: string): string => {
  const [hours = '0', minutes = '00'] = time.split(':');
  const hour = Number(hours);
  return `${hour === 1 ? 'a la' : 'a las'} ${hour}:${minutes}`;
};

/** `['a', 'b', 'c']` → `a, b y c`. */
const joined = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;

const DAY_MS = 86_400_000;

/**
 * `{cuando}` of a one-time reminder (R-25 AC11), from its local date (`YYYY-MM-DD`) and time
 * (`HH:mm`) in `TZ` and today there: `hoy a las 9:00`, `mañana …`, `ayer …` or
 * `el 29 de octubre a las 9:00`.
 */
export const formatWhenOnce = (date: string, time: string, today: string): string => {
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
  const day =
    days === 0 ? 'hoy' : days === 1 ? 'mañana' : days === -1 ? 'ayer' : `el ${formatDate(date)}`;
  return `${day} ${atTime(time)}`;
};

/** A repetition as stored in `recurrence_json` (PRD §13): `days` 1 Monday to 7 Sunday. */
export interface RecurrenceWhen {
  freq: 'daily' | 'weekly' | 'monthly';
  days?: readonly number[];
  day?: number;
  time: string;
}

const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados', 'domingos'];

/**
 * `{cuando}` of a repeating reminder (R-25 AC11): `todos los días a las 9:00`,
 * `todos los lunes y jueves a las 8:00` or `el día 15 de cada mes a las 9:00`.
 */
export const formatRecurrence = ({ freq, days = [], day, time }: RecurrenceWhen): string => {
  if (freq === 'daily') return `todos los días ${atTime(time)}`;
  if (freq === 'monthly') return `el día ${day} de cada mes ${atTime(time)}`;
  const names = [...new Set(days)].sort((a, b) => a - b).map((d) => WEEKDAYS[d - 1] ?? '');
  return `todos los ${joined(names)} ${atTime(time)}`;
};

/** `{categoria}` when there is no category. */
export const UNCATEGORIZED = 'sin clasificar';

const category = (name: string | null): string => name ?? UNCATEGORIZED;

/** S-9 writes each category name with a capital letter: `supermercado` → `Supermercado`. */
const capitalized = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

// S-27, S-29, S-44 and S-46: a header followed by one line per item.
const lines = (header: string, items: readonly string[]): string => [header, ...items].join('\n');

/** A pending reminder (`when` is its `{cuando}`) or task (`when` is `null`) in S-44 and S-46. */
export interface PendingItem {
  text: string;
  when: string | null;
}

/** S-44 and S-46: `· {texto} ({cuando})` for a reminder, `· {texto}` for a task. */
const pendingLines = (header: string, items: readonly PendingItem[]): string =>
  lines(
    header,
    items.map(({ text, when }) => (when === null ? `· ${text}` : `· ${text} (${when})`)),
  );

export const strings = {
  registered: (total: number, merchant: string, categoryName: string | null) =>
    `Apuntado: ${formatAmount(total)} en ${merchant} (${category(categoryName)}).`,
  registeredNoMerchant: (total: number, categoryName: string | null) =>
    `Apuntado: ${formatAmount(total)} (${category(categoryName)}).`,
  linesMismatch: (sum: number, total: number) =>
    `No cuadra: las líneas suman ${formatAmount(sum)} y el total dice ${formatAmount(total)}. ¿Qué hago?`,
  duplicate: (total: number, merchant: string, date: string) =>
    `Parece repetido: ya apunté ${formatAmount(total)} en ${merchant} el ${formatDate(date)}. ¿Lo apunto otra vez?`,
  unreadableReceipt: () => 'No he podido leer el ticket. ¿Me escribes el total y el comercio?',
  confirmCategory: (total: number, merchant: string, date: string, categoryName: string | null) =>
    `${formatAmount(total)} en ${merchant}, el ${formatDate(date)}. Lo clasificaría como ${category(categoryName)}. ¿Lo apunto?`,
  askCorrection: () => '¿Qué cambio? Escríbelo, por ejemplo: total 28,40',
  corrected: (total: number, merchant: string, categoryName: string | null) =>
    `Corregido: ${formatAmount(total)} en ${merchant} (${category(categoryName)}).`,
  /**
   * S-9, with `categories` already in the order of R-10 AC4; `Sin clasificar` is always last.
   * `start` and `end` are `YYYY-MM-DD`.
   */
  weeklySummary: (
    start: string,
    end: string,
    total: number,
    categories: readonly { name: string; cents: number }[],
    uncategorized: number,
    pending: number,
  ) => {
    const breakdown = [...categories, { name: UNCATEGORIZED, cents: uncategorized }]
      .map(({ name, cents }) => `${capitalized(name)} ${formatAmount(cents)}`)
      .join(' · ');
    return `Semana del ${formatDate(start)} al ${formatDate(end)}: ${formatAmount(total)}. ${breakdown}. Pendientes de confirmar: ${pending}.`;
  },
  aiLimitReached: () => 'He llegado al límite diario de IA. Leeré este ticket mañana.',
  confirmPolicy: (merchant: string, categoryName: string) =>
    `¿Guardo la regla «${merchant} es ${categoryName}»?`,
  proposePattern: (pattern: string) => `He notado que ${pattern}. ¿Lo convierto en regla?`,
  /** `{patron}` of S-12 (R-13 AC2). */
  pattern: (merchant: string, categoryName: string) => `${merchant} siempre es ${categoryName}`,
  keepUnreadReceipt: (date: string) =>
    `Todavía no he podido leer el ticket que me enviaste el ${formatDate(date)}. ¿Lo guardo hasta poder leerlo? Si no, lo borro en una hora.`,
  deletedUnreadReceipt: (date: string) =>
    `He borrado sin leer el ticket que me enviaste el ${formatDate(date)}.`,
  confirmNewCategory: (categoryName: string) => `¿Creo la categoría «${categoryName}»?`,
  unclearAmount: () => 'No tengo claro el importe. ¿Me lo escribes? Por ejemplo: 23,40',
  unsupportedInput: () => 'De momento solo entiendo texto y fotos de tickets.',
  pdfNotSupported: () => 'Todavía no leo PDF. ¿Me mandas una foto del ticket?',
  decisionClosed: () => 'Esa pregunta ya no está abierta.',
  imageTooLarge: () => 'La imagen es demasiado grande. ¿Me mandas una foto más ligera?',
  futureDate: (date: string) =>
    `La fecha ${formatDate(date)} es posterior a hoy. ¿Me dices cuándo fue el gasto?`,
  processingFailed: () =>
    'Algo ha fallado y no he podido procesar tu mensaje. ¿Me lo vuelves a enviar en un rato?',
  discarded: (total: number, merchant: string) =>
    `Descartado: no he apuntado ${formatAmount(total)} en ${merchant}.`,
  receiptKept: (lastDay: string) =>
    `Vale, lo guardo hasta poder leerlo, como mucho hasta el ${formatDate(lastDay)}.`,
  receiptNotKept: () => 'Vale, si no consigo leerlo antes, lo borro en una hora.',
  textLimitReached: () =>
    'He llegado al límite diario de IA y hoy no puedo procesar más mensajes. ¿Me lo vuelves a enviar mañana?',
  /** S-27: the header, then one line per memory with how it was learnt. */
  remembered: (memories: readonly { text: string; mode: 'declared' | 'inferred' }[]) =>
    lines(
      'Esto es lo que recuerdo de ti:',
      memories.map(
        ({ text, mode }) => `· ${text} (${mode === 'declared' ? 'me lo dijiste' : 'lo deduje'})`,
      ),
    ),
  rememberNothing: () => 'Todavía no recuerdo nada de ti.',
  /** S-29: the header, then one line per memory. With no texts, the header alone. */
  confirmForget: (texts: readonly string[]) =>
    lines(
      '¿Olvido esto?',
      texts.map((text) => `· ${text}`),
    ),
  forgotten: () => 'Hecho, lo he olvidado.',
  notForgotten: () => 'Vale, no olvido nada.',
  nothingToForget: () => 'No encuentro nada así en lo que recuerdo.',
  futureReceipt: (total: number, merchant: string, date: string) =>
    `${formatAmount(total)} en ${merchant}, con fecha ${formatDate(date)}, que aún no ha llegado. ¿Lo apunto así o corrijo la fecha?`,
  categoryNotCreated: () => 'Vale, no la creo.',
  categoryExists: (categoryName: string) => `La categoría «${categoryName}» ya existe.`,
  categoryCreated: (categoryName: string) => `Hecho, he creado la categoría «${categoryName}».`,
  policyNotSaved: () => 'Vale, no guardo la regla.',
  /** S-38: the reply to "Sí" to S-11 or S-12. */
  policySaved: (merchant: string, categoryName: string) =>
    `Hecho, he guardado la regla «${merchant} es ${categoryName}».`,
  policyExists: (merchant: string, categoryName: string) =>
    `Ya tengo la regla «${merchant} es ${categoryName}».`,
  /** S-40, with `when` from `formatWhenOnce` or `formatRecurrence`. */
  reminderSet: (when: string, text: string) => `Te lo recuerdo ${when}: ${text}.`,
  taskAdded: (text: string) => `Apuntado en tus pendientes: ${text}.`,
  recurrenceUnsupported: () =>
    'Todavía no sé repetir recordatorios así. Puedo cada día, cada semana o cada mes.',
  timePassed: () => 'Esa hora ya pasó. ¿Para cuándo lo quieres?',
  reminderDue: (text: string) => `Recordatorio: ${text}.`,
  /** S-43: sent more than 10 minutes late (R-25 AC7), with `when` from `formatWhenOnce`. */
  reminderLate: (when: string, text: string) => `Recordatorio (era para ${when}): ${text}.`,
  /** S-44: reminders soonest first, then tasks oldest first (R-25 AC8). */
  pending: (items: readonly PendingItem[]) => pendingLines('Esto tienes pendiente:', items),
  nothingPending: () => 'No tienes nada pendiente.',
  /** S-46: the header, then one line per item. With no items, the header alone. */
  confirmCancel: (items: readonly PendingItem[]) => pendingLines('¿Cancelo esto?', items),
  cancelled: () => 'Hecho, cancelado.',
  notCancelled: () => 'Vale, no cancelo nada.',
  nothingPendingMatches: () => 'No encuentro nada así en tus pendientes.',
  /** S-50: the texts joined with `, ` and ` y ` before the last one. */
  markedDone: (texts: readonly string[]) => `Hecho: ${joined(texts)}.`,
} as const;

/** PRD §12 button labels (R-6 AC3; S-11, S-12, S-13, S-15, S-29 and S-46 use `Sí` and `No`). */
export const buttons = {
  register: 'Apuntar',
  correct: 'Corregir',
  discard: 'Descartar',
  yes: 'Sí',
  no: 'No',
} as const;
