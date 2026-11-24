import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordMessages, storedConversation } from '../../src/store/conversation.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';
import {
  type ActionKind,
  forgetAction,
  listActions,
  recordAction,
} from '../../src/store/history.ts';
import { forgetMemoryAndItsTurns, saveMemory } from '../../src/store/memory.ts';

// DK-18 AC4, AC5: forgetting one item in Memoria erases the turns that mention it, never an
// unrelated one ("Solo los mensajes que lo contienen", decided by the principal on 2026-11-24).
const AT = '2026-11-24T10:00:00.000Z';

let scratch: string;
let db: Database.Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-forget-one-'));
  db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A principal's message and the reply it got. */
const turn = (said: string, replied: string): void => {
  recordMessages(db, [
    { from: 'principal', door: 'app', text: said, buttons: [], channelRef: null, at: AT },
    { from: 'anomander', door: 'app', text: replied, buttons: [], channelRef: null, at: AT },
  ]);
};
const texts = (): string[] => storedConversation(db, 500).map(({ text }) => text);
const action = (task: string, kind: ActionKind = 'screen'): number => {
  recordAction(db, {
    kind,
    door: 'app',
    task,
    outcome: 'done',
    steps: null,
    calls: null,
    endedAt: AT,
  });
  return listActions(db)[0]?.id ?? 0;
};
const remember = (quote: string, text = 'Le gusta el café', said = false): number =>
  saveMemory(db, {
    text,
    quote,
    said,
    confidence: 0.7,
    message: quote,
    source: 'telegram:1',
    replaces: null,
    receivedAt: AT,
    now: AT,
  });

describe('forgetting one action', () => {
  it('a short task erases its own turn and keeps an unrelated one that says the same word', () => {
    turn('[captura de pantalla] hola', 'Hola, veo un editor');
    turn('hola, ¿cuánto gasté ayer?', '12 €');

    forgetAction(db, action('hola'));

    expect(texts()).toEqual(['hola, ¿cuánto gasté ayer?', '12 €']);
  });

  it('erases the turn of each kind as it is stored: [control del ordenador], [conexiones]', () => {
    turn('[control del ordenador] abre Notas', 'Hecho.');
    turn('[conexiones] busca vuelos', 'He encontrado tres.');
    turn('abre Notas', 'Te lo abro.');

    forgetAction(db, action('abre Notas', 'computer'));
    forgetAction(db, action('busca vuelos', 'connect'));

    expect(texts()).toEqual(['abre Notas', 'Te lo abro.']);
  });

  it('a task of 3 or more words also erases the turns whose messages say the whole task', () => {
    turn('lee el correo de Marta, por favor', 'Te lo leo.');
    turn('¿qué hiciste ayer?', 'Ayer: lee el correo de Marta.');
    turn('¿y el correo?', 'Ninguno nuevo.');

    forgetAction(db, action('lee el correo de Marta', 'computer'));

    expect(texts()).toEqual(['¿y el correo?', 'Ninguno nuevo.']);
  });
});

describe('forgetting one memory', () => {
  it('a quote of fewer than 3 words erases only a principal message that is exactly it', () => {
    turn('Sí', 'Anotado');
    turn('sí, apunta 5 € de pan', 'Apuntado');

    forgetMemoryAndItsTurns(db, remember('sí'));

    expect(texts()).toEqual(['sí, apunta 5 € de pan', 'Apuntado']);
  });

  it('a text of fewer than 3 words erases no reply that merely holds it', () => {
    turn('¿qué sabes de mí?', 'Sé que es vegetariano.');
    turn('Es vegetariano', 'Vale.');

    forgetMemoryAndItsTurns(
      db,
      remember('soy vegetariano y no como carne', 'Es vegetariano', true),
    );

    expect(texts()).toEqual(['¿qué sabes de mí?', 'Sé que es vegetariano.']);
  });
});
