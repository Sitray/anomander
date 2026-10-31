import { formatRecurrence, formatWhenOnce } from '@anomander/protocol';

// R-25 AC3, AC11: reminder times are kept in UTC and read in `TZ`. Code does this date math; the
// processor only gives a local time or a repetition.

/** A repetition as stored in `recurrence_json` (PRD §13): `days` 1 Monday to 7 Sunday. */
export type Recurrence =
  | { freq: 'daily'; time: string }
  | { freq: 'weekly'; days: number[]; time: string }
  | { freq: 'monthly'; day: number; time: string };

/** The local date (`YYYY-MM-DD`), time (`HH:mm`) and English weekday of `instant` in `timeZone`. */
export const localParts = (
  instant: Date,
  timeZone: string,
): { date: string; time: string; weekday: string; second: number } => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
    weekday: part('weekday'),
    second: Number(part('second')),
  };
};

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
const offsetAt = (instant: number, timeZone: string): number => {
  const { date, time, second } = localParts(new Date(instant), timeZone);
  const wall = Date.parse(`${date}T${time}:00Z`) + second * 1000;
  return wall - (instant - (instant % 1000));
};

/**
 * The instant of a local date and time in `timeZone`. A time skipped by a daylight-saving change
 * moves forward by the change (02:30 → 03:30); a repeated one takes its second occurrence.
 */
export const utcOf = (date: string, time: string, timeZone: string): Date => {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const guess = wall - offsetAt(wall, timeZone);
  return new Date(wall - offsetAt(guess, timeZone));
};

const DAY_MS = 86_400_000;

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const isoWeekday = (date: string): number => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

const daysInMonth = (date: string): number => {
  const [year = 0, month = 0] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

/** R-25 AC3: a monthly day that a month does not have falls on its last day (assumption). */
const falls = (recurrence: Recurrence, date: string): boolean => {
  if (recurrence.freq === 'daily') return true;
  if (recurrence.freq === 'weekly') return recurrence.days.includes(isoWeekday(date));
  return Number(date.slice(8, 10)) === Math.min(recurrence.day, daysInMonth(date));
};

/** The first occurrence of `recurrence` strictly after `now`, at its local time in `timeZone`. */
export const nextOccurrence = (recurrence: Recurrence, now: Date, timeZone: string): Date => {
  const today = localParts(now, timeZone).date;
  // Every repetition falls at least once in any 62 days in a row.
  for (let offset = 0; offset <= 62; offset += 1) {
    const date = addDays(today, offset);
    if (!falls(recurrence, date)) continue;
    const at = utcOf(date, recurrence.time, timeZone);
    if (at > now) return at;
  }
  throw new Error(`no occurrence of a ${recurrence.freq} reminder in 62 days`);
};

/** R-25 AC11: `{cuando}` of a reminder, or `null` for a task. */
export const whenOf = (
  reminder: { due_at: string | null; recurrence: Recurrence | null },
  now: Date,
  timeZone: string,
): string | null => {
  if (reminder.recurrence !== null) return formatRecurrence(reminder.recurrence);
  if (reminder.due_at === null) return null;
  const { date, time } = localParts(new Date(reminder.due_at), timeZone);
  return formatWhenOnce(date, time, localParts(now, timeZone).date);
};
