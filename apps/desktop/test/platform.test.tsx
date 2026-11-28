// @vitest-environment jsdom
import { setLocale } from '@anomander/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { platform } from '../src/platform.ts';
import { type Strings, strings } from '../src/strings.ts';

// DK-20 (B28): on Windows the window never speaks of macOS, the Keychain or "este Mac"; a look at
// the screen and a task on the computer say they are not on Windows yet. macOS reads as before.
afterEach(() => {
  delete window.__ANOMANDER_PLATFORM__;
  setLocale('es');
});

/** Every text of the window in the current language, functions called with sample arguments. */
const everyText = (): string[] => {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') found.push(value);
    else if (typeof value === 'function') {
      // Dates, months and counts fail on a word: each text is read with the samples it accepts.
      for (const sample of ['x', '2026-11', '2026-11-25T10:00:00Z', 2]) {
        try {
          const text: unknown = value(sample, sample, sample);
          if (typeof text === 'string') found.push(text);
        } catch {}
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const key of Object.keys(value)) walk(Reflect.get(value, key));
    }
  };
  walk(strings);
  return found;
};

const MACOS_ONLY = /\bMac\b|macOS|Ajustes del Sistema|System Settings|llavero|Keychain/;

describe('the platform of the window', () => {
  it('is the one the shell said, and macOS when it said nothing', () => {
    expect(platform()).toBe('macos');
    window.__ANOMANDER_PLATFORM__ = 'windows';
    expect(platform()).toBe('windows');
  });
});

describe('the text on Windows', () => {
  it('never names macOS, the Keychain, "este Mac" or System Settings, in either language', () => {
    window.__ANOMANDER_PLATFORM__ = 'windows';
    for (const locale of ['es', 'en'] as const) {
      setLocale(locale);
      const texts = everyText();
      expect(texts.length).toBeGreaterThan(100);
      expect(texts.filter((text) => MACOS_ONLY.test(text))).toEqual([]);
    }
  });

  it('never offers a look at the screen in the empty chat, which Windows does not have yet', () => {
    window.__ANOMANDER_PLATFORM__ = 'windows';
    for (const locale of ['es', 'en'] as const) {
      setLocale(locale);
      expect(strings.chat.examples.filter((text) => /pantalla|screen/i.test(text))).toEqual([]);
      expect(strings.chat.emptyBody).not.toMatch(/pantalla|screen/i);
      expect(strings.chat.examples.length).toBeGreaterThan(2);
    }
    // macOS still offers it.
    delete window.__ANOMANDER_PLATFORM__;
    setLocale('es');
    expect(strings.chat.examples).toContain('¿Qué ves en mi pantalla?');
    expect(strings.chat.emptyBody).toContain('miro tu pantalla');
  });

  it('names the Windows Credential Manager where macOS names the Keychain', () => {
    window.__ANOMANDER_PLATFORM__ = 'windows';
    expect(strings.setup.intro).toBe(
      'Las claves se guardan en el Administrador de credenciales de Windows, nunca en un archivo.',
    );
    expect(strings.connections.confirmRemove('Notion')).toBe(
      '¿Quitar «Notion»? Sus valores guardados se borrarán del Administrador de credenciales.',
    );
    setLocale('en');
    expect(strings.setup.intro).toBe(
      'Keys are kept in the Windows Credential Manager, never in a file.',
    );
  });

  it('says "este equipo" where macOS says "este Mac"', () => {
    window.__ANOMANDER_PLATFORM__ = 'windows';
    expect(strings.connections.kindProcess).toBe('Un programa en este equipo');
    setLocale('en');
    expect(strings.connections.kindProcess).toBe('A program on this computer');
  });

  it('says a look at the screen and a task on the computer are not on Windows yet', () => {
    window.__ANOMANDER_PLATFORM__ = 'windows';
    expect(strings.chat.screenPermission).toBe('Todavía no puedo ver tu pantalla en Windows.');
    expect(strings.chat.computerPermission).toBe('Todavía no puedo usar tu ordenador en Windows.');
    setLocale('en');
    expect(strings.chat.screenPermission).toBe("I can't see your screen on Windows yet.");
    expect(strings.chat.computerPermission).toBe("I can't use your computer on Windows yet.");
  });
});

/** Each other text that names the computer or its store: where it says it, in each language. */
const WINDOWS_WORDING: [string, (text: Strings) => string, string, string][] = [
  [
    'chat.confirmClear',
    (t) => t.chat.confirmClear,
    'la borra de este equipo y',
    'erases it from this computer and',
  ],
  [
    'connections.intro',
    (t) => t.connections.intro,
    'Sus claves se guardan en el Administrador de credenciales de Windows.',
    'Their keys are kept in the Windows Credential Manager.',
  ],
  [
    'connections.webSearchNote',
    (t) => t.connections.webSearchNote,
    'Las páginas se leen desde este equipo, siempre',
    'Pages are read from this computer, always',
  ],
  [
    'connections.confirmRemove',
    (t) => t.connections.confirmRemove('Notion'),
    'se borrarán del Administrador de credenciales.',
    'will be deleted from the Credential Manager.',
  ],
  [
    'connections.advancedNote',
    (t) => t.connections.advancedNote,
    'un programa de este equipo o una dirección web',
    'a program on this computer or a web address',
  ],
  [
    'connections.urlHelp',
    (t) => t.connections.urlHelp,
    'si el servidor está en este equipo.',
    'if the server is on this computer.',
  ],
  [
    'connections.envHelp',
    (t) => t.connections.envHelp,
    'Los valores se guardan en el Administrador de credenciales de Windows; aquí',
    'The values are kept in the Windows Credential Manager; only',
  ],
  [
    'connections.headersHelp',
    (t) => t.connections.headersHelp,
    'Los valores se guardan en el Administrador de credenciales de Windows; aquí',
    'The values are kept in the Windows Credential Manager; only',
  ],
  [
    'subscriptions.intro',
    (t) => t.subscriptions.intro,
    'La cuenta se guarda en el Administrador de credenciales de Windows.',
    'The account is kept in the Windows Credential Manager.',
  ],
  [
    'memory.intro',
    (t) => t.memory.intro,
    'Todo está en este equipo, y',
    'All of it is on this computer, and',
  ],
  [
    'memory.confirmMemory',
    (t) => t.memory.confirmMemory,
    '¿Lo olvido? Lo borro de este equipo, y',
    'Shall I forget it? I erase it from this computer, and',
  ],
  [
    'memory.confirmAction',
    (t) => t.memory.confirmAction,
    '¿Lo olvido? Lo borro de este equipo, y',
    'Shall I forget it? I erase it from this computer, and',
  ],
  [
    'ledger.intro',
    (t) => t.ledger.intro,
    'copia su archivo de datos a este equipo y',
    'copy its data file to this computer and',
  ],
];

describe('each other text on Windows', () => {
  it.each(WINDOWS_WORDING)('%s names this computer or its store', (_name, read, es, en) => {
    window.__ANOMANDER_PLATFORM__ = 'windows';
    expect(read(strings)).toContain(es);
    setLocale('en');
    expect(read(strings)).toContain(en);
  });
});

describe('the text on macOS', () => {
  it('reads as before', () => {
    expect(strings.setup.intro).toBe(
      'Las claves se guardan en el llavero de macOS, nunca en un archivo.',
    );
    expect(strings.connections.kindProcess).toBe('Un programa en este Mac');
    expect(strings.chat.screenPermission).toMatch(/^macOS no me deja ver la pantalla\./);
    setLocale('en');
    expect(strings.setup.intro).toBe('Keys are kept in the macOS Keychain, never in a file.');
  });
});
