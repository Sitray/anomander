import { setLocale } from '@anomander/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionTaskPrompt } from '../../src/connections/task.ts';
import { computerPlannerPrompt } from '../../src/processor/computer-planner.ts';
import { replyPhraserPrompt } from '../../src/processor/reply-phraser.ts';
import { screenReaderPrompt } from '../../src/processor/screen-reader.ts';
import { textInterpreterPrompt } from '../../src/processor/text-interpreter.ts';

// S1, S5: the model answers in the language the daemon chose at startup; the references and
// formats it is told to copy are the ones code writes in that language.
afterEach(() => {
  setLocale('es');
});

const PROMPTS = {
  'reply phraser': replyPhraserPrompt,
  'screen reader': screenReaderPrompt,
  'computer planner': computerPlannerPrompt,
  'connection task': connectionTaskPrompt,
  'text interpreter': textInterpreterPrompt,
};

describe('the language the model answers in', () => {
  it.each(Object.entries(PROMPTS))('the %s asks for English under en', (_name, prompt) => {
    setLocale('en');
    expect(prompt()).toContain('English');
    expect(prompt()).not.toContain('Spanish');
  });

  it.each(Object.entries(PROMPTS))('the %s asks for Spanish under es', (_name, prompt) => {
    expect(prompt()).toContain('Spanish (es-ES)');
    expect(prompt()).not.toContain('English');
  });

  it('every reply the text interpreter writes is asked for in English (en-GB)', () => {
    setLocale('en');
    const prompt = textInterpreterPrompt();
    expect(prompt).toContain('a short, friendly reply in English (en-GB)>');
    expect(prompt).toContain('"<the fact, short, in English>"');
  });

  it('gives the text interpreter English references and amounts under en', () => {
    setLocale('en');
    const prompt = textInterpreterPrompt();
    expect(prompt).toContain('"23.40" is 2340, "€23" is 2300');
    expect(prompt).toContain(
      'saying the same as: The category “<name in lowercase>” already exists.',
    );
    expect(prompt).toContain(
      'saying the same as: I already have the rule “<merchant> is <category in lowercase>”.',
    );
    expect(prompt).toContain("saying the same as: I'll remind you <when>: <text>.");
    expect(prompt).toContain('says the same as: Added to your pending list: <text>.');
    expect(prompt).toContain(
      'Write <when> as "today at 9:00", "tomorrow at 9:00", "on 29 October at 9:00", "every day at 9:00", "every Monday and Thursday at 8:00" or "on day 15 of every month at 9:00"',
    );
    expect(prompt).not.toContain('La categoría');
    expect(prompt).not.toContain('Te lo recuerdo');
  });

  it('keeps the Spanish references and amounts under es', () => {
    const prompt = textInterpreterPrompt();
    expect(prompt).toContain('"23,40" is 2340, "23 €" is 2300');
    expect(prompt).toContain('saying the same as: La categoría «<name in lowercase>» ya existe.');
    expect(prompt).toContain(
      'saying the same as: Ya tengo la regla «<merchant> es <category in lowercase>».',
    );
    expect(prompt).toContain('saying the same as: Te lo recuerdo <when>: <text>.');
    expect(prompt).toContain('says the same as: Apuntado en tus pendientes: <text>.');
    expect(prompt).toContain(
      'Write <when> as "hoy a las 9:00", "mañana a las 9:00", "el 29 de octubre a las 9:00", "todos los días a las 9:00", "todos los lunes y jueves a las 8:00" or "el día 15 de cada mes a las 9:00", and "hoy a la 1:00" at one o\'clock.',
    );
  });
});
