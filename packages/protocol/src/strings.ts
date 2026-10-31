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

/** `{categoria}` when there is no category. */
export const UNCATEGORIZED = 'sin clasificar';

const category = (name: string | null): string => name ?? UNCATEGORIZED;

/** S-9 writes each category name with a capital letter: `supermercado` → `Supermercado`. */
const capitalized = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

// S-27 and S-29: a header followed by one line per item.
const lines = (header: string, items: readonly string[]): string => [header, ...items].join('\n');

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
} as const;

/** PRD §12 button labels (R-6 AC3; S-11, S-12, S-13, S-15 and S-29 use `Sí` and `No`). */
export const buttons = {
  register: 'Apuntar',
  correct: 'Corregir',
  discard: 'Descartar',
  yes: 'Sí',
  no: 'No',
} as const;
