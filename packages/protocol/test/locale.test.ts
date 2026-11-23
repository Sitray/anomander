import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, localeOf, perLocale, setLocale } from '../src/locale.ts';

afterEach(() => setLocale('es'));

describe('the language of the text', () => {
  it('is Spanish until a process chooses another', () => {
    expect(getLocale()).toBe('es');
    setLocale('en');
    expect(getLocale()).toBe('en');
  });

  it('is Spanish for any Spanish system language and English for every other one', () => {
    for (const tag of ['es', 'es-ES', 'es-419', 'ES_ar', 'es_ES.UTF-8', ' es-MX ']) {
      expect(localeOf(tag), tag).toBe('es');
    }
    for (const tag of ['en', 'en-US', 'fr-FR', 'pt-BR', 'eso', 'C', '', null, undefined]) {
      expect(localeOf(tag), String(tag)).toBe('en');
    }
  });

  it('reads the table of the language chosen when it is read, not when it was made', () => {
    const said = perLocale({
      es: { yes: 'Sí', hi: () => 'Hola' },
      en: { yes: 'Yes', hi: () => 'Hi' },
    });
    expect(said.yes).toBe('Sí');
    setLocale('en');
    expect(said.yes).toBe('Yes');
    expect(said.hi()).toBe('Hi');
    expect(Object.keys(said)).toEqual(['yes', 'hi']);
  });
});
