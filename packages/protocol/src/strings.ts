// PRD §12: every user-facing string, verbatim, in Spanish (`es-ES`) and English (`en-GB`
// amounts and dates). Nothing else may build bot text. Each phrase, button and formatter speaks
// the language chosen with `setLocale` at the moment it is read; until then, Spanish.

import { getLocale, type Locale, perLocale } from './locale.ts';

const amountFormats: Record<Locale, Intl.NumberFormat> = {
  es: new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }),
  en: new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' }),
};
const dateOptions: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', timeZone: 'UTC' };
const dateFormats: Record<Locale, Intl.DateTimeFormat> = {
  es: new Intl.DateTimeFormat('es-ES', dateOptions),
  en: new Intl.DateTimeFormat('en-GB', dateOptions),
};

/** `2340` → `23,40 €`, or `€23.40` in English. */
export const formatAmount = (cents: number): string =>
  amountFormats[getLocale()].format(cents / 100);

/** `2026-10-29` → `29 de octubre`, or `29 October` in English. */
export const formatDate = (isoDate: string): string =>
  dateFormats[getLocale()].format(new Date(`${isoDate}T00:00:00Z`));

/** `HH:mm` → `H:mm`: `07:30 → 7:30`. */
const clock = (time: string): string => {
  const [hours = '0', minutes = '00'] = time.split(':');
  return `${Number(hours)}:${minutes}`;
};

/** The words a `{cuando}` and a list are built from, in one language. */
interface Calendar {
  /** R-25 AC11: `9:00 → a las 9:00`, but `1:00 → a la 1:00`; `at 9:00` in English. */
  at: (time: string) => string;
  today: string;
  tomorrow: string;
  yesterday: string;
  on: (date: string) => string;
  daily: (at: string) => string;
  /** `days` already joined. */
  weekly: (days: string, at: string) => string;
  monthly: (day: number | undefined, at: string) => string;
  /** 1 Monday to 7 Sunday, as said after "every". */
  weekdays: readonly string[];
  /** Before the last item of a list. */
  and: string;
  /** `{categoria}` when there is no category. */
  uncategorized: string;
}

/** `{categoria}` when there is no category, as the daemon stores and compares it. */
export const UNCATEGORIZED = 'sin clasificar';

const calendar = perLocale<Calendar>({
  es: {
    at: (time) => `${Number(time.split(':')[0] ?? '0') === 1 ? 'a la' : 'a las'} ${clock(time)}`,
    today: 'hoy',
    tomorrow: 'mañana',
    yesterday: 'ayer',
    on: (date) => `el ${date}`,
    daily: (at) => `todos los días ${at}`,
    weekly: (days, at) => `todos los ${days} ${at}`,
    monthly: (day, at) => `el día ${day} de cada mes ${at}`,
    weekdays: ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados', 'domingos'],
    and: 'y',
    uncategorized: UNCATEGORIZED,
  },
  en: {
    at: (time) => `at ${clock(time)}`,
    today: 'today',
    tomorrow: 'tomorrow',
    yesterday: 'yesterday',
    on: (date) => `on ${date}`,
    daily: (at) => `every day ${at}`,
    weekly: (days, at) => `every ${days} ${at}`,
    monthly: (day, at) => `on day ${day} of every month ${at}`,
    weekdays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    and: 'and',
    uncategorized: 'uncategorized',
  },
});

/** `{categoria}` when there is no category, in the language chosen: `uncategorized` in English. */
export const uncategorized = (): string => calendar.uncategorized;

const atTime = (time: string): string => calendar.at(time);

/** `['a', 'b', 'c']` → `a, b y c`, or `a, b and c` in English. */
const joined = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} ${calendar.and} ${items.at(-1)}`;

const DAY_MS = 86_400_000;

/**
 * `{cuando}` of a one-time reminder (R-25 AC11), from its local date (`YYYY-MM-DD`) and time
 * (`HH:mm`) in `TZ` and today there: `hoy a las 9:00`, `mañana …`, `ayer …` or
 * `el 29 de octubre a las 9:00`; in English `today at 9:00`, … or `on 29 October at 9:00`.
 */
export const formatWhenOnce = (date: string, time: string, today: string): string => {
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
  const day =
    days === 0
      ? calendar.today
      : days === 1
        ? calendar.tomorrow
        : days === -1
          ? calendar.yesterday
          : calendar.on(formatDate(date));
  return `${day} ${atTime(time)}`;
};

/** A repetition as stored in `recurrence_json` (PRD §13): `days` 1 Monday to 7 Sunday. */
export interface RecurrenceWhen {
  freq: 'daily' | 'weekly' | 'monthly';
  days?: readonly number[];
  day?: number;
  time: string;
}

/**
 * `{cuando}` of a repeating reminder (R-25 AC11): `todos los días a las 9:00`,
 * `todos los lunes y jueves a las 8:00` or `el día 15 de cada mes a las 9:00`; in English
 * `every day at 9:00`, `every Monday and Thursday at 8:00` or `on day 15 of every month at 9:00`.
 */
export const formatRecurrence = ({ freq, days = [], day, time }: RecurrenceWhen): string => {
  if (freq === 'daily') return calendar.daily(atTime(time));
  if (freq === 'monthly') return calendar.monthly(day, atTime(time));
  const names = [...new Set(days)].sort((a, b) => a - b).map((d) => calendar.weekdays[d - 1] ?? '');
  return calendar.weekly(joined(names), atTime(time));
};

const category = (name: string | null): string => name ?? uncategorized();

/** S-9 writes each category name with a capital letter: `supermercado` → `Supermercado`. */
const capitalized = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

// S-27, S-29, S-44 and S-46: a header followed by one line per item.
const lines = (header: string, items: readonly string[]): string => [header, ...items].join('\n');

/** A pending reminder (`when` is its `{cuando}`) or task (`when` is `null`) in S-44 and S-46. */
export interface PendingItem {
  text: string;
  when: string | null;
}

/** What the morning digest holds (R-26 AC5). */
export interface MorningDigest {
  /** Today's pending reminders from now on, soonest first; `time` is local `HH:mm`. */
  today: readonly { time: string; text: string }[];
  /** Every pending task, oldest first. */
  tasks: readonly string[];
  /** The number of expenses whose status is `pending`. */
  pendingExpenses: number;
}

/** S-44 and S-46: `· {texto} ({cuando})` for a reminder, `· {texto}` for a task. */
const pendingLines = (header: string, items: readonly PendingItem[]): string =>
  lines(
    header,
    items.map(({ text, when }) => (when === null ? `· ${text}` : `· ${text} (${when})`)),
  );

/** What code computed for a free query on the expenses (R-30), for S-90 to S-94. */
export interface ExpenseQueryAnswer {
  /** The period, `YYYY-MM-DD`, both included. */
  from: string;
  to: string;
  /** Today in `TZ`: a period outside its year, or across two years, names its years. */
  today: string;
  /** The category asked about, as stored; `null` when none. */
  category: string | null;
  /** The merchant asked about, as the principal wrote it; `null` when none. */
  merchant: string | null;
  /** The sum of the current expenses, in cents. */
  total: number;
  /** How many current expenses the total sums. */
  count: number;
  /** `{desglose}`, already in its order; a `null` name is `Sin clasificar`. */
  breakdown: readonly { name: string | null; cents: number }[];
  /** What the breakdown leaves out, listed last as `Otros`; 0 when nothing is. */
  others: number;
  /** The expenses of the period pending confirmation, never in `total`. */
  pending: number;
}

/** `{desglose}` of S-90 and S-91: `{Nombre} {importe}` joined by ` · `, as S-9, then the rest. */
const queryBreakdown = ({ breakdown, others }: ExpenseQueryAnswer, othersLabel: string): string =>
  [...breakdown, ...(others > 0 ? [{ name: othersLabel, cents: others }] : [])]
    .map(({ name, cents }) => `${capitalized(name ?? uncategorized())} ${formatAmount(cents)}`)
    .join(' · ');

const datedOptions: Intl.DateTimeFormatOptions = { ...dateOptions, year: 'numeric' };
const datedFormats: Record<Locale, Intl.DateTimeFormat> = {
  es: new Intl.DateTimeFormat('es-ES', datedOptions),
  en: new Intl.DateTimeFormat('en-GB', datedOptions),
};

/**
 * The days of `{periodo}` (S-90 to S-93): `1 de noviembre`, or `1 de noviembre de 2025` when the
 * period is not within today's year.
 */
const queryDays = ({ from, to, today }: ExpenseQueryAnswer): [string, string] => {
  const year = today.slice(0, 4);
  const thisYear = from.slice(0, 4) === year && to.slice(0, 4) === year;
  const format = (date: string) =>
    thisYear ? formatDate(date) : datedFormats[getLocale()].format(new Date(`${date}T00:00:00Z`));
  return [format(from), format(to)];
};

/** `{filtro}` of S-91 and S-93: `supermercado`, `mercadona` or `mercadona (supermercado)`. */
const queryFilter = ({ category, merchant }: ExpenseQueryAnswer): string | null =>
  merchant === null ? category : category === null ? merchant : `${merchant} (${category})`;

const es = {
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
    uncategorizedCents: number,
    pending: number,
  ) => {
    const breakdown = [...categories, { name: uncategorized(), cents: uncategorizedCents }]
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
  /** S-100: "Deshacer" took a typed expense out of the ledger (R-7 AC5). */
  undone: (total: number, merchant: string) =>
    `Deshecho: he quitado ${formatAmount(total)} en ${merchant} de tus gastos.`,
  /** S-101: S-100 when the expense has no merchant. */
  undoneNoMerchant: (total: number) => `Deshecho: he quitado ${formatAmount(total)} de tus gastos.`,
  /** S-102: S-8 when the expense, a receipt's or a text's, has no merchant (R-7 AC2). */
  correctedNoMerchant: (total: number, categoryName: string | null) =>
    `Corregido: ${formatAmount(total)} (${category(categoryName)}).`,
  /** S-103: a typed correction that does not say which expense (R-7 AC7). */
  whichExpense: () =>
    `¿Qué gasto corrijo? Dímelo con su importe, por ejemplo: el de ${formatAmount(2340)}.`,
  /** S-104: a typed correction with no recent expense to correct (R-7 AC7). */
  nothingToCorrect: () => 'No encuentro un gasto reciente que corregir.',
  receiptKept: (lastDay: string) =>
    `Vale, lo guardo hasta poder leerlo, como mucho hasta el ${formatDate(lastDay)}.`,
  receiptNotKept: () => 'Vale, si no consigo leerlo antes, lo borro en una hora.',
  /** DK-10 AC3: what an action is, said by code. `target` is the processor's claim, quoted. */
  computerClick: (target: string, double: boolean) =>
    `Quiero hacer ${double ? 'doble clic' : 'clic'} en «${target}».`,
  /** The exact text that would be typed. */
  computerType: (text: string) => `Quiero escribir: «${text}»`,
  /** `keys` as the keyboard shows them, such as `⌘C`. */
  computerKey: (keys: string) => `Quiero pulsar ${keys}.`,
  computerScroll: (direction: 'up' | 'down') =>
    `Quiero desplazar la pantalla hacia ${direction === 'up' ? 'arriba' : 'abajo'}.`,
  computerTooManySteps: (steps: number) =>
    `He llegado al máximo de ${steps} pasos seguidos y paro aquí. Si quieres que siga, pídemelo otra vez.`,
  computerFailed: () => 'No he sabido qué hacer en tu ordenador. ¿Me lo pides de otra forma?',
  /**
   * DK-11: the call a task with connections wants to make, said by code. `args` is the exact
   * JSON of its arguments.
   */
  connectionCall: (tool: string, server: string, args: string) =>
    `Quiero usar «${tool}» de «${server}» con:\n${args}`,
  connectionAllow: () => 'Permitir',
  connectionRefuse: () => 'Detener',
  connectionStopped: () => 'Detenido. No he hecho nada más.',
  connectionGone: () => 'Esa petición ya no está pendiente.',
  /** A task was asked while another one runs: there is one at a time. */
  connectionBusy: () => 'Todavía estoy con la tarea anterior. Pídeme otra cuando termine.',
  // DK-13 AC2: what a routed request announces before it starts.
  routedScreen: () => 'Miro tu pantalla.',
  routedComputer: () => 'Me pongo con ello en tu ordenador.',
  routedConnect: () => 'Lo miro en tus conexiones.',
  routeInApp: () => 'Eso solo puedo hacerlo desde la app de ANOMANDER en tu Mac.',
  /** T17: a lookup on the internet with no connection that searches; never the computer. */
  webSearchMissing: () =>
    'Para buscar en internet necesito la conexión de búsqueda web. Añádela en Conexiones, en la app de ANOMANDER, y vuelve a pedírmelo.',
  /** `/mcp` with no task after it, in Telegram. */
  connectionUsage: () => 'Dime qué quieres que haga con tus conexiones: /mcp y la tarea.',
  connectionNone: () =>
    'No tengo ninguna conexión disponible. Añádelas en mcp.json, en la carpeta de datos de ANOMANDER, y reinicia.',
  /** The servers of `mcp.json` that could not be connected; no other is. */
  connectionUnreachable: (servers: readonly string[]) =>
    `No he podido conectar con ${servers.map((server) => `«${server}»`).join(', ')}. Revisa cómo están en mcp.json y vuelve a pedírmelo.`,
  connectionFileInvalid: () =>
    'No puedo usar mcp.json: no es un JSON válido o algún servidor no está bien escrito. Corrígelo y reinicia.',
  /** Added to how a task was cut short, when it had made calls by then. */
  connectionPerformed: (calls: number) =>
    calls === 1
      ? 'Antes de parar se hizo 1 llamada a tus conexiones.'
      : `Antes de parar se hicieron ${calls} llamadas a tus conexiones.`,
  connectionTooManyCalls: (calls: number) =>
    `He llegado al máximo de ${calls} llamadas seguidas y paro aquí. Si quieres que siga, pídemelo otra vez.`,
  connectionFailed: () => 'No he podido hacerlo con tus conexiones. ¿Me lo pides de otra forma?',
  /** The AI provider answered 429: its own quota or rate limit, not ANOMANDER's daily cap. */
  providerLimitReached: () =>
    'Tu proveedor de IA no acepta más peticiones por ahora: has agotado su cuota. Prueba más tarde o revisa tu plan.',
  screenNotSeen: () => 'No he podido ver tu pantalla. ¿Me lo vuelves a pedir en un rato?',
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
  // DK-14 AC4: erasing the history of what ANOMANDER did, after "Sí".
  confirmForgetHistory: (count: number) =>
    `¿Borro el historial de lo que he hecho por ti? ${count === 1 ? 'Es 1 acción' : `Son ${count} acciones`} y no podré recuperarlas.`,
  historyForgotten: () => 'Hecho, he borrado mi historial.',
  historyNotForgotten: () => 'Vale, no borro nada.',
  noHistory: () => 'No tengo nada en mi historial.',
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
  /** S-53, with `time` as `HH:mm` (R-26 AC1, AC3). */
  confirmDigest: (time: string) =>
    `¿Te mando cada mañana ${atTime(time)} un resumen con tus recordatorios del día, tus pendientes y los gastos por confirmar?`,
  /** S-54: the reply to "Sí" to S-53 (R-26 AC2). */
  digestOn: (time: string) => `Hecho: te lo mando cada mañana ${atTime(time)}.`,
  /** S-55. */
  digestNotOn: () => 'Vale, no te lo mando.',
  /** S-56 (R-26 AC4). */
  digestOff: () => 'Hecho, ya no te mando el resumen de la mañana.',
  /**
   * S-57: `Buenos días.`, then only the parts that have something (R-26 AC5). The caller sends
   * nothing when every part is empty.
   */
  morningDigest: ({ today, tasks, pendingExpenses }: MorningDigest) =>
    [
      'Buenos días.',
      ...(today.length === 0
        ? []
        : ['Hoy:', ...today.map(({ time, text }) => `· ${clock(time)} ${text}`)]),
      ...(tasks.length === 0 ? [] : ['Pendientes:', ...tasks.map((text) => `· ${text}`)]),
      ...(pendingExpenses === 0 ? [] : [`Gastos por confirmar: ${pendingExpenses}`]),
    ].join('\n'),
  /** S-58. */
  digestWasOff: () => 'No tenía activado el resumen de la mañana.',
  /** S-59: the time asked for is the one already active (R-26 AC3). */
  digestAlreadyOn: (time: string) => `Ya te lo mando cada mañana ${atTime(time)}.`,
  /** S-60: the `/login` reply, with one button per account (R-27 AC1). */
  chooseLoginAccount: () => '¿Con qué cuenta me conecto?',
  /** S-62: ChatGPT's login, whose redirect fails on a phone (R-27 AC2). */
  loginPasteAddress: () =>
    'Abre el enlace y acepta. Cuando el navegador dé error, copia la dirección completa de esa página y pégamela aquí.',
  /** S-63: Kimi Code's device code (R-27 AC2). */
  loginDeviceCode: (code: string) => `Abre el enlace y escribe este código: ${code}`,
  /** S-64. `account` is the button label, such as `ChatGPT`. */
  loginConnected: (account: string) => `Conectado con tu cuenta de ${account}.`,
  /** S-65. */
  loginFailed: (account: string) =>
    `No he podido conectar con tu cuenta de ${account}. Puedes intentarlo otra vez con /login.`,
  /** S-66: the `/logout` reply, with one button per connected account (R-27 AC6). */
  chooseLogoutAccount: () => '¿Qué cuenta desconecto?',
  /** S-67. */
  loggedOut: (account: string) => `Hecho, he desconectado tu cuenta de ${account}.`,
  /** S-68. */
  noAccountConnected: () => 'No hay ninguna cuenta conectada.',
  /** S-69: the `/start` reply once setup is complete (R-28 AC1). */
  hello: () => '¡Hola!',
  /** S-70: the setup guide, one line per gap (S-71 to S-73) after it (R-28 AC3). */
  setupGuide: (lines: readonly string[]) => ['¡Hola! Me falta:', ...lines].join('\n'),
  /** S-71. */
  setupModelUnset: () =>
    '- El modelo y el modelo de visión (ANOMANDER_MODEL y ANOMANDER_VISION_MODEL en el .env).',
  /** S-72. `variable` is `ANOMANDER_MODEL` or `ANOMANDER_VISION_MODEL`. */
  setupModelUnknown: (variable: string, model: string) =>
    `- Un modelo que exista en ${variable}: ${model} no lo encuentro.`,
  /** S-73. `provider` is the login button label, such as `ChatGPT`, or the pi-ai provider ID. */
  setupProviderUnconnected: (provider: string) =>
    `- Conectar tu cuenta de ${provider} (/login o su API key en el .env).`,
  // DK-23 AC5: the same gaps as the desktop app's chat says them: about the window, never `.env`.
  /** S-171. */
  appSetupModelUnset: () => '- Elegir el modelo: abre Configuración, en la barra de arriba.',
  /** S-172. */
  appSetupModelUnknown: (model: string) =>
    `- Un modelo que exista: ${model} no lo encuentro. Elige otro en Configuración.`,
  /** S-173. `provider` as in S-73. */
  appSetupProviderUnconnected: (provider: string) =>
    `- Conectar tu cuenta de ${provider}: pon su clave en Configuración o conéctala en Suscripciones.`,
  /** S-74 (R-10 AC6); "No" replies S-55. */
  confirmWeeklySummary: () => '¿Te mando cada semana un resumen de tus gastos?',
  /** S-75: the reply to "Sí" to S-74 (R-10 AC6). */
  weeklySummaryOn: () => 'Hecho: te mando el resumen de tus gastos cada semana.',
  /** S-76: the summary is already on (R-10 AC6). */
  weeklySummaryAlreadyOn: () => 'Ya te mando el resumen de tus gastos cada semana.',
  /** S-77 (R-10 AC7). */
  weeklySummaryOff: () => 'Hecho, ya no te mando el resumen semanal.',
  /** S-78. */
  weeklySummaryWasOff: () => 'No tenía activado el resumen semanal.',
  /** S-79: the reply to `/exportar`, before its files (R-29 AC3). */
  exportSent: () =>
    'Aquí tienes tus datos: gastos, líneas de compra y pendientes de confirmar, en CSV y en JSON.',
  /** S-80: the export could not be written (R-29 AC3). */
  exportFailed: () => 'No he podido exportar tus datos. Inténtalo de nuevo en un rato.',
  /** S-81: `/exportar` in the app (R-29 AC4). */
  exportOnlyInTelegram: () =>
    'De momento la exportación solo llega por Telegram: escribe /exportar allí.',
  /**
   * S-90 to S-94 (R-30): S-90 for every expense, S-91 with a filter, S-92 and S-93 when nothing
   * was spent, each followed by S-94 when some expense of the period is pending confirmation.
   */
  expenseQuery: (answer: ExpenseQueryAnswer) => {
    const [from, to] = queryDays(answer);
    const period = answer.from === answer.to ? `El ${from}` : `Del ${from} al ${to}`;
    const filter = queryFilter(answer);
    const breakdown = queryBreakdown(answer, 'otros');
    const sentence =
      answer.count === 0
        ? `${period} no hay gastos${filter === null ? '' : ` en ${filter}`}.`
        : `${period}${filter === null ? '' : `, en ${filter}`}: ${formatAmount(answer.total)} en ${answer.count} ${answer.count === 1 ? 'gasto' : 'gastos'}.${breakdown === '' ? '' : ` ${breakdown}.`}`;
    return answer.pending === 0
      ? sentence
      : `${sentence} Pendientes de confirmar: ${answer.pending}.`;
  },
} as const;

/**
 * PRD §12 button labels (R-6 AC3; S-11, S-12, S-13, S-15, S-29, S-46, S-53 and S-74 use `Sí` and `No`; S-60
 * and S-66 one account each, and S-66 also the accounts no longer offered for login; S-62 and S-63 `Abrir`, a link).
 */
const esButtons = {
  register: 'Apuntar',
  correct: 'Corregir',
  discard: 'Descartar',
  /** R-7 AC4: under the S-1 or S-2 of a typed expense, with `Corregir`. */
  undo: 'Deshacer',
  yes: 'Sí',
  no: 'No',
  chatGpt: 'ChatGPT',
  kimiCode: 'Kimi Code',
  claude: 'Claude',
  gitHubCopilot: 'GitHub Copilot',
  open: 'Abrir',
};

const en: typeof es = {
  registered: (total, merchant, categoryName) =>
    `Logged: ${formatAmount(total)} at ${merchant} (${category(categoryName)}).`,
  registeredNoMerchant: (total, categoryName) =>
    `Logged: ${formatAmount(total)} (${category(categoryName)}).`,
  linesMismatch: (sum, total) =>
    `This doesn't add up: the lines come to ${formatAmount(sum)} and the total says ${formatAmount(total)}. What should I do?`,
  duplicate: (total, merchant, date) =>
    `Looks like a repeat: I already logged ${formatAmount(total)} at ${merchant} on ${formatDate(date)}. Shall I log it again?`,
  unreadableReceipt: () => "I couldn't read the receipt. Can you write me the total and the shop?",
  confirmCategory: (total, merchant, date, categoryName) =>
    `${formatAmount(total)} at ${merchant}, on ${formatDate(date)}. I'd file it under ${category(categoryName)}. Shall I log it?`,
  askCorrection: () => 'What should I change? Write it, for example: total 28.40',
  corrected: (total, merchant, categoryName) =>
    `Corrected: ${formatAmount(total)} at ${merchant} (${category(categoryName)}).`,
  weeklySummary: (start, end, total, categories, uncategorizedCents, pending) => {
    const breakdown = [...categories, { name: uncategorized(), cents: uncategorizedCents }]
      .map(({ name, cents }) => `${capitalized(name)} ${formatAmount(cents)}`)
      .join(' · ');
    return `Week of ${formatDate(start)} to ${formatDate(end)}: ${formatAmount(total)}. ${breakdown}. Waiting for your confirmation: ${pending}.`;
  },
  aiLimitReached: () => "I've hit the daily AI limit. I'll read this receipt tomorrow.",
  confirmPolicy: (merchant, categoryName) =>
    `Shall I save the rule “${merchant} is ${categoryName}”?`,
  proposePattern: (pattern) => `I've noticed that ${pattern}. Shall I make it a rule?`,
  pattern: (merchant, categoryName) => `${merchant} is always ${categoryName}`,
  keepUnreadReceipt: (date) =>
    `I still haven't been able to read the receipt you sent me on ${formatDate(date)}. Shall I keep it until I can? If not, I'll delete it in an hour.`,
  deletedUnreadReceipt: (date) =>
    `I've deleted the receipt you sent me on ${formatDate(date)} without reading it.`,
  confirmNewCategory: (categoryName) => `Shall I create the category “${categoryName}”?`,
  unclearAmount: () => "I'm not sure about the amount. Can you write it for me? For example: 23.40",
  unsupportedInput: () => 'For now I only understand text and photos of receipts.',
  pdfNotSupported: () => "I can't read PDFs yet. Can you send me a photo of the receipt?",
  decisionClosed: () => 'That question is no longer open.',
  imageTooLarge: () => 'The image is too large. Can you send me a smaller photo?',
  futureDate: (date) =>
    `The date ${formatDate(date)} is after today. Can you tell me when the expense was?`,
  processingFailed: () =>
    "Something went wrong and I couldn't process your message. Can you send it again in a while?",
  discarded: (total, merchant) =>
    `Discarded: I haven't logged ${formatAmount(total)} at ${merchant}.`,
  undone: (total, merchant) =>
    `Undone: I removed ${formatAmount(total)} at ${merchant} from your expenses.`,
  undoneNoMerchant: (total) => `Undone: I removed ${formatAmount(total)} from your expenses.`,
  correctedNoMerchant: (total, categoryName) =>
    `Corrected: ${formatAmount(total)} (${category(categoryName)}).`,
  whichExpense: () =>
    `Which expense should I fix? Tell me its amount, for example: the ${formatAmount(2340)} one.`,
  nothingToCorrect: () => "I can't find a recent expense to fix.",
  receiptKept: (lastDay) =>
    `OK, I'll keep it until I can read it, until ${formatDate(lastDay)} at the latest.`,
  receiptNotKept: () => "OK, if I can't read it before then, I'll delete it in an hour.",
  computerClick: (target, double) =>
    `I want to ${double ? 'double-click' : 'click'} on “${target}”.`,
  computerType: (text) => `I want to type: “${text}”`,
  computerKey: (keys) => `I want to press ${keys}.`,
  computerScroll: (direction) =>
    `I want to scroll the screen ${direction === 'up' ? 'up' : 'down'}.`,
  computerTooManySteps: (steps) =>
    `I've reached the maximum of ${steps} steps in a row, so I'm stopping here. If you want me to carry on, ask me again.`,
  computerFailed: () =>
    "I couldn't work out what to do on your computer. Can you ask me another way?",
  connectionCall: (tool, server, args) => `I want to use “${tool}” from “${server}” with:\n${args}`,
  connectionAllow: () => 'Allow',
  connectionRefuse: () => 'Stop',
  connectionStopped: () => "Stopped. I haven't done anything else.",
  connectionGone: () => 'That request is no longer pending.',
  connectionBusy: () => "I'm still on the previous task. Ask me for another one when it's done.",
  routedScreen: () => "I'm looking at your screen.",
  routedComputer: () => "I'm on it, on your computer.",
  routedConnect: () => "I'll look it up in your connections.",
  routeInApp: () => 'I can only do that from the ANOMANDER app on your Mac.',
  webSearchMissing: () =>
    'To search the internet I need the web search connection. Add it in Connections, in the ANOMANDER app, and ask me again.',
  connectionUsage: () => 'Tell me what you want me to do with your connections: /mcp and the task.',
  connectionNone: () =>
    "I don't have any connections available. Add them to mcp.json, in ANOMANDER's data folder, and restart.",
  connectionUnreachable: (servers) =>
    `I couldn't connect to ${servers.map((server) => `“${server}”`).join(', ')}. Check them in mcp.json and ask me again.`,
  connectionFileInvalid: () =>
    "I can't use mcp.json: it isn't valid JSON or a server isn't written correctly. Fix it and restart.",
  connectionPerformed: (calls) =>
    calls === 1
      ? 'Before stopping, 1 call was made to your connections.'
      : `Before stopping, ${calls} calls were made to your connections.`,
  connectionTooManyCalls: (calls) =>
    `I've reached the maximum of ${calls} calls in a row, so I'm stopping here. If you want me to carry on, ask me again.`,
  connectionFailed: () => "I couldn't do it with your connections. Can you ask me another way?",
  providerLimitReached: () =>
    "Your AI provider isn't taking any more requests for now: you've used up its quota. Try again later or check your plan.",
  screenNotSeen: () => "I couldn't see your screen. Can you ask me again in a while?",
  textLimitReached: () =>
    "I've hit the daily AI limit and can't process any more messages today. Can you send it again tomorrow?",
  remembered: (memories) =>
    lines(
      "Here's what I remember about you:",
      memories.map(
        ({ text, mode }) =>
          `· ${text} (${mode === 'declared' ? 'you told me' : 'I worked it out'})`,
      ),
    ),
  rememberNothing: () => "I don't remember anything about you yet.",
  confirmForget: (texts) =>
    lines(
      'Shall I forget this?',
      texts.map((text) => `· ${text}`),
    ),
  forgotten: () => "Done, I've forgotten it.",
  notForgotten: () => "OK, I won't forget anything.",
  nothingToForget: () => "I can't find anything like that in what I remember.",
  confirmForgetHistory: (count) =>
    `Shall I erase the history of what I've done for you? ${count === 1 ? "That's 1 action" : `That's ${count} actions`} and I won't be able to get them back.`,
  historyForgotten: () => "Done, I've erased my history.",
  historyNotForgotten: () => "OK, I won't erase anything.",
  noHistory: () => "I don't have anything in my history.",
  futureReceipt: (total, merchant, date) =>
    `${formatAmount(total)} at ${merchant}, dated ${formatDate(date)}, which hasn't come yet. Shall I log it like that or correct the date?`,
  categoryNotCreated: () => "OK, I won't create it.",
  categoryExists: (categoryName) => `The category “${categoryName}” already exists.`,
  categoryCreated: (categoryName) => `Done, I've created the category “${categoryName}”.`,
  policyNotSaved: () => "OK, I won't save the rule.",
  policySaved: (merchant, categoryName) =>
    `Done, I've saved the rule “${merchant} is ${categoryName}”.`,
  policyExists: (merchant, categoryName) =>
    `I already have the rule “${merchant} is ${categoryName}”.`,
  reminderSet: (when, text) => `I'll remind you ${when}: ${text}.`,
  taskAdded: (text) => `Added to your pending list: ${text}.`,
  recurrenceUnsupported: () =>
    "I can't repeat reminders like that yet. I can do every day, every week or every month.",
  timePassed: () => 'That time has already passed. When do you want it for?',
  reminderDue: (text) => `Reminder: ${text}.`,
  reminderLate: (when, text) => `Reminder (it was for ${when}): ${text}.`,
  pending: (items) => pendingLines("Here's what you have pending:", items),
  nothingPending: () => 'You have nothing pending.',
  confirmCancel: (items) => pendingLines('Shall I cancel this?', items),
  cancelled: () => 'Done, cancelled.',
  notCancelled: () => "OK, I won't cancel anything.",
  nothingPendingMatches: () => "I can't find anything like that in your pending list.",
  markedDone: (texts) => `Done: ${joined(texts)}.`,
  confirmDigest: (time) =>
    `Shall I send you a summary every morning ${atTime(time)} with your reminders for the day, your pending items and the expenses to confirm?`,
  digestOn: (time) => `Done: I'll send it to you every morning ${atTime(time)}.`,
  digestNotOn: () => "OK, I won't send it.",
  digestOff: () => "Done, I won't send you the morning summary any more.",
  morningDigest: ({ today, tasks, pendingExpenses }) =>
    [
      'Good morning.',
      ...(today.length === 0
        ? []
        : ['Today:', ...today.map(({ time, text }) => `· ${clock(time)} ${text}`)]),
      ...(tasks.length === 0 ? [] : ['Pending:', ...tasks.map((text) => `· ${text}`)]),
      ...(pendingExpenses === 0 ? [] : [`Expenses to confirm: ${pendingExpenses}`]),
    ].join('\n'),
  digestWasOff: () => "The morning summary wasn't on.",
  digestAlreadyOn: (time) => `I already send it to you every morning ${atTime(time)}.`,
  chooseLoginAccount: () => 'Which account shall I connect with?',
  loginPasteAddress: () =>
    'Open the link and accept. When the browser shows an error, copy the full address of that page and paste it here.',
  loginDeviceCode: (code) => `Open the link and enter this code: ${code}`,
  loginConnected: (account) => `Connected to your ${account} account.`,
  loginFailed: (account) =>
    `I couldn't connect to your ${account} account. You can try again with /login.`,
  chooseLogoutAccount: () => 'Which account shall I disconnect?',
  loggedOut: (account) => `Done, I've disconnected your ${account} account.`,
  noAccountConnected: () => 'No account is connected.',
  hello: () => 'Hi!',
  setupGuide: (lines) => ['Hi! I still need:', ...lines].join('\n'),
  setupModelUnset: () =>
    '- The model and the vision model (ANOMANDER_MODEL and ANOMANDER_VISION_MODEL in the .env).',
  setupModelUnknown: (variable, model) =>
    `- A model that exists in ${variable}: I can't find ${model}.`,
  setupProviderUnconnected: (provider) =>
    `- Your ${provider} account connected (/login or its API key in the .env).`,
  appSetupModelUnset: () => '- The model chosen: open Settings, in the bar at the top.',
  appSetupModelUnknown: (model) =>
    `- A model that exists: I can't find ${model}. Pick another one in Settings.`,
  appSetupProviderUnconnected: (provider) =>
    `- Your ${provider} account connected: add its key in Settings or connect it in Subscriptions.`,
  confirmWeeklySummary: () => 'Shall I send you a summary of your expenses every week?',
  weeklySummaryOn: () => "Done: I'll send you a summary of your expenses every week.",
  weeklySummaryAlreadyOn: () => 'I already send you a summary of your expenses every week.',
  weeklySummaryOff: () => "Done, I won't send you the weekly summary any more.",
  weeklySummaryWasOff: () => "The weekly summary wasn't on.",
  exportSent: () =>
    'Here is your data: expenses, purchase lines and pending confirmations, as CSV and JSON.',
  exportFailed: () => "I couldn't export your data. Try again in a while.",
  exportOnlyInTelegram: () =>
    'For now the export only comes through Telegram: send /exportar there.',
  expenseQuery: (answer) => {
    const [from, to] = queryDays(answer);
    const period = answer.from === answer.to ? `on ${from}` : `from ${from} to ${to}`;
    const filter = queryFilter(answer);
    const breakdown = queryBreakdown(answer, 'others');
    const sentence =
      answer.count === 0
        ? `No expenses${filter === null ? '' : ` for ${filter}`} ${period}.`
        : `${capitalized(period)}${filter === null ? '' : `, for ${filter}`}: ${formatAmount(answer.total)} in ${answer.count} ${answer.count === 1 ? 'expense' : 'expenses'}.${breakdown === '' ? '' : ` ${breakdown}.`}`;
    return answer.pending === 0
      ? sentence
      : `${sentence} Waiting for your confirmation: ${answer.pending}.`;
  },
};

/** Every bot phrase, in the language chosen when it is read. */
export const strings = perLocale({ es, en });

const enButtons: typeof esButtons = {
  register: 'Log',
  correct: 'Edit',
  discard: 'Discard',
  undo: 'Undo',
  yes: 'Yes',
  no: 'No',
  chatGpt: 'ChatGPT',
  kimiCode: 'Kimi Code',
  claude: 'Claude',
  gitHubCopilot: 'GitHub Copilot',
  open: 'Open',
};

/** The button labels, in the language chosen when they are read. */
export const buttons: Readonly<typeof esButtons> = perLocale({ es: esButtons, en: enButtons });
