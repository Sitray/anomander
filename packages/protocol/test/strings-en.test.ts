import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../src/locale.ts';
import {
  buttons,
  formatAmount,
  formatDate,
  formatRecurrence,
  formatWhenOnce,
  strings,
  UNCATEGORIZED,
  uncategorized,
} from '../src/strings.ts';

afterEach(() => setLocale('es'));

const TODAY = '2026-10-28';

describe('the bot text in Spanish, until a process chooses another language', () => {
  it('formats amounts and dates as es-ES', () => {
    expect(formatAmount(2340)).toBe('23,40 €');
    expect(formatDate('2026-10-29')).toBe('29 de octubre');
  });

  it('says when a reminder is due as it always did', () => {
    expect(formatWhenOnce('2026-10-28', '09:00', TODAY)).toBe('hoy a las 9:00');
    expect(formatWhenOnce('2026-10-29', '01:00', TODAY)).toBe('mañana a la 1:00');
    expect(formatWhenOnce('2026-10-27', '09:00', TODAY)).toBe('ayer a las 9:00');
    expect(formatWhenOnce('2026-11-05', '09:00', TODAY)).toBe('el 5 de noviembre a las 9:00');
    expect(formatRecurrence({ freq: 'daily', time: '09:00' })).toBe('todos los días a las 9:00');
    expect(formatRecurrence({ freq: 'weekly', days: [4, 1], time: '08:00' })).toBe(
      'todos los lunes y jueves a las 8:00',
    );
    expect(formatRecurrence({ freq: 'monthly', day: 15, time: '09:00' })).toBe(
      'el día 15 de cada mes a las 9:00',
    );
  });

  it('keeps the phrases, the missing category and the buttons', () => {
    expect(strings.registered(2340, 'Mercadona', null)).toBe(
      'Apuntado: 23,40 € en Mercadona (sin clasificar).',
    );
    expect(strings.reminderSet('mañana a las 9:00', 'llamar a mamá')).toBe(
      'Te lo recuerdo mañana a las 9:00: llamar a mamá.',
    );
    expect(strings.markedDone(['a', 'b', 'c'])).toBe('Hecho: a, b y c.');
    expect(strings.weeklySummary('2026-10-19', '2026-10-25', 3000, [], 3000, 0)).toBe(
      'Semana del 19 de octubre al 25 de octubre: 30,00 €. Sin clasificar 30,00 €. Pendientes de confirmar: 0.',
    );
    expect(UNCATEGORIZED).toBe('sin clasificar');
    expect(uncategorized()).toBe('sin clasificar');
    expect(buttons.yes).toBe('Sí');
  });
});

describe('the bot text in English', () => {
  it('formats amounts as en-GB euros and dates as day and month', () => {
    setLocale('en');
    expect(formatAmount(2340)).toBe('€23.40');
    expect(formatDate('2026-10-29')).toBe('29 October');
  });

  it('says when a reminder is due in English', () => {
    setLocale('en');
    expect(formatWhenOnce('2026-10-28', '09:00', TODAY)).toBe('today at 9:00');
    expect(formatWhenOnce('2026-10-29', '09:00', TODAY)).toBe('tomorrow at 9:00');
    expect(formatWhenOnce('2026-10-27', '09:00', TODAY)).toBe('yesterday at 9:00');
    expect(formatWhenOnce('2026-10-29', '09:00', '2026-10-20')).toBe('on 29 October at 9:00');
    expect(formatWhenOnce('2026-10-29', '01:00', TODAY)).toBe('tomorrow at 1:00');
    expect(formatRecurrence({ freq: 'daily', time: '09:00' })).toBe('every day at 9:00');
    expect(formatRecurrence({ freq: 'weekly', days: [4, 1], time: '08:00' })).toBe(
      'every Monday and Thursday at 8:00',
    );
    expect(formatRecurrence({ freq: 'monthly', day: 15, time: '09:00' })).toBe(
      'on day 15 of every month at 9:00',
    );
  });

  it('speaks English in the phrases, the missing category and the buttons', () => {
    setLocale('en');
    expect(strings.registered(2340, 'Tesco', null)).toBe(
      'Logged: €23.40 at Tesco (uncategorized).',
    );
    expect(strings.reminderSet('tomorrow at 9:00', 'call mum')).toBe(
      "I'll remind you tomorrow at 9:00: call mum.",
    );
    expect(strings.markedDone(['a', 'b', 'c'])).toBe('Done: a, b and c.');
    expect(strings.weeklySummary('2026-10-19', '2026-10-25', 3000, [], 3000, 0)).toBe(
      'Week of 19 October to 25 October: €30.00. Uncategorized €30.00. Waiting for your confirmation: 0.',
    );
    const query = { from: '2026-11-01', to: '2026-11-24', category: null, merchant: null };
    expect(
      strings.expenseQuery({
        ...query,
        total: 3800,
        count: 2,
        breakdown: [
          { name: 'supermercado', cents: 3000 },
          { name: null, cents: 800 },
        ],
        pending: 1,
      }),
    ).toBe(
      'From 1 November to 24 November: €38.00 in 2 expenses. Supermercado €30.00 · Uncategorized €8.00. Waiting for your confirmation: 1.',
    );
    expect(
      strings.expenseQuery({
        ...query,
        to: '2026-11-01',
        merchant: 'mercadona',
        total: 0,
        count: 0,
        breakdown: [],
        pending: 0,
      }),
    ).toBe('No expenses for mercadona on 1 November.');
    expect(UNCATEGORIZED).toBe('sin clasificar');
    expect(uncategorized()).toBe('uncategorized');
    expect(buttons.yes).toBe('Yes');
  });

  it('translates every phrase that takes no arguments', () => {
    const phrases = Object.entries(strings).filter(([, phrase]) => phrase.length === 0);
    const spanish = phrases.map(([key, phrase]) => [key, (phrase as () => string)()]);
    setLocale('en');
    for (const [key, text] of spanish) {
      const english = (strings[key as keyof typeof strings] as () => string)();
      expect(english, key).not.toBe('');
      expect(english, key).not.toBe(text);
    }
    expect(phrases.length).toBeGreaterThan(40);
  });
});

// Probes of the independent verifier: thousands in English, and one o'clock in Spanish.
describe('two edge cases of the formats', () => {
  afterEach(() => setLocale('es'));

  it('writes thousands with a comma in English', () => {
    setLocale('en');
    expect(strings.registered(123456, 'Mercadona', null)).toBe(
      'Logged: €1,234.56 at Mercadona (uncategorized).',
    );
  });

  it('keeps "a la 1:00" in Spanish', () => {
    expect(strings.digestOn('01:00')).toBe('Hecho: te lo mando cada mañana a la 1:00.');
  });
});
