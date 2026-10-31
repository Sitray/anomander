import { describe, expect, it } from 'vitest';
import { nextOccurrence, type Recurrence, whenOf } from '../../src/reminders/when.ts';

// R-25 AC3, AC11: `{cuando}` and the next occurrence are computed by code in `TZ`.
const TZ = 'Europe/Madrid';
// Friday 30 October 2026, 11:00 in Madrid (CET, after the 25 October change).
const NOW = new Date('2026-10-30T10:00:05.000Z');

const daily = (time: string): Recurrence => ({ freq: 'daily', time });
const weekly = (days: number[], time: string): Recurrence => ({ freq: 'weekly', days, time });
const monthly = (day: number, time: string): Recurrence => ({ freq: 'monthly', day, time });

describe('whenOf (R-25 AC11)', () => {
  it.each([
    [{ due_at: '2026-10-30T15:30:00.000Z', recurrence: null }, 'hoy a las 16:30'],
    [{ due_at: '2026-10-31T08:00:00.000Z', recurrence: null }, 'mañana a las 9:00'],
    [{ due_at: '2026-10-29T08:00:00.000Z', recurrence: null }, 'ayer a las 9:00'],
    [{ due_at: '2026-11-02T00:00:00.000Z', recurrence: null }, 'el 2 de noviembre a la 1:00'],
    [{ due_at: null, recurrence: null }, null],
    [{ due_at: 'x', recurrence: daily('09:00') }, 'todos los días a las 9:00'],
    [{ due_at: 'x', recurrence: weekly([4, 1], '08:00') }, 'todos los lunes y jueves a las 8:00'],
    [
      { due_at: 'x', recurrence: weekly([1, 3, 5], '08:00') },
      'todos los lunes, miércoles y viernes a las 8:00',
    ],
    [{ due_at: 'x', recurrence: weekly([6], '10:00') }, 'todos los sábados a las 10:00'],
    [{ due_at: 'x', recurrence: monthly(15, '09:00') }, 'el día 15 de cada mes a las 9:00'],
  ])('%j reads %j', (reminder, expected) => {
    expect(whenOf(reminder, NOW, TZ)).toBe(expected);
  });
});

describe('nextOccurrence (R-25 AC3)', () => {
  it.each([
    ['daily, today already passed', daily('09:00'), NOW, '2026-10-31T08:00:00.000Z'],
    ['daily, later today', daily('12:00'), NOW, '2026-10-30T11:00:00.000Z'],
    ['weekly on Monday and Thursday', weekly([1, 4], '08:00'), NOW, '2026-11-02T07:00:00.000Z'],
    [
      'monthly on the 31st in a 30-day month',
      monthly(31, '09:00'),
      new Date('2026-11-05T12:00:00.000Z'),
      '2026-11-30T08:00:00.000Z',
    ],
    [
      'monthly on the 29th in a February of 28 days',
      monthly(29, '09:00'),
      new Date('2027-02-10T12:00:00.000Z'),
      '2027-02-28T08:00:00.000Z',
    ],
    [
      'daily across the autumn change, still 9:00 local',
      daily('09:00'),
      new Date('2026-10-24T08:00:00.000Z'),
      '2026-10-25T08:00:00.000Z',
    ],
    [
      'daily across the spring change, still 9:00 local',
      daily('09:00'),
      new Date('2027-03-27T12:00:00.000Z'),
      '2027-03-28T07:00:00.000Z',
    ],
  ])('%s', (_label, recurrence, now, expected) => {
    expect(nextOccurrence(recurrence, now, TZ).toISOString()).toBe(expected);
  });
});
