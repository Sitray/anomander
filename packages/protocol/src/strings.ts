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
} as const;

/** PRD §12 button labels (R-6 AC3; S-11, S-12, S-13 and S-15 use `Sí` and `No`). */
export const buttons = {
  register: 'Apuntar',
  correct: 'Corregir',
  discard: 'Descartar',
  yes: 'Sí',
  no: 'No',
} as const;
