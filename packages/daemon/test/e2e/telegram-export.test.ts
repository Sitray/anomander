import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FakeTelegramApi,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { applyMigrations, openDatabase } from '../../src/store/database.ts';

// End to end (PRD §15): R-29 AC3, `/exportar` over the fake Telegram API sends S-79 and the
// export's files as documents, with no processor call.
const PRINCIPAL = 4242;
const NOW = new Date('2026-11-24T10:30:00.000Z');

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };
const complete = vi.fn(async () => {
  throw new Error('the processor must not be called');
});

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-export-'));
  api = await startFakeTelegramApi();
  logger = { info: vi.fn<Log>(), warn: vi.fn<Log>(), error: vi.fn<Log>() };
  complete.mockClear();
  const db = openDatabase(join(scratch, 'anomander.db'));
  applyMigrations(db);
  db.prepare(
    `INSERT INTO expenses (occurred_on, total_cents, category_id, mode, status, created_at)
     VALUES ('2026-11-23', 2300, (SELECT id FROM categories WHERE name = 'restaurantes'),
             'declared', 'current', ?)`,
  ).run(NOW.toISOString());
  db.close();
  anomander = startAnomander(
    loadConfig({
      TELEGRAM_BOT_TOKEN: api.token,
      ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
      ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
      ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
      ANOMANDER_MODEL: 'openai/gpt-4o-mini',
      ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
    }),
    {
      complete,
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
      now: () => NOW,
    },
  );
  await anomander.started;
});

afterEach(async () => {
  await anomander.stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('/exportar over Telegram (R-29 AC3)', () => {
  it('sends S-79, then the CSV files and ledger.json as documents, kept owner only', async () => {
    api.push(updates.text({ chatId: PRINCIPAL }, '/exportar'));

    const [reply] = await api.waitForSent(1);
    expect(reply).toMatchObject({
      chatId: PRINCIPAL,
      text: 'Aquí tienes tus datos: gastos, líneas de compra y pendientes de confirmar, en CSV y en JSON.',
    });
    const documents = await api.waitForDocuments(4);
    expect(documents.map((document) => document.fileName)).toEqual([
      'gastos.csv',
      'lineas_de_compra.csv',
      'pendientes_de_confirmar.csv',
      'ledger.json',
    ]);
    expect(documents.every((document) => document.chatId === PRINCIPAL)).toBe(true);
    expect(new TextDecoder().decode(documents[0]?.bytes)).toMatch(
      /^id,fecha,comercio,categoria,total_cents,modo,origen\r\n\d+,2026-11-23,,restaurantes,2300,declared,texto\r\n$/,
    );
    expect(JSON.parse(new TextDecoder().decode(documents[3]?.bytes))).toMatchObject({
      exported_at: NOW.toISOString(),
      pendientes_de_confirmar: { cantidad: 0, total_cents: 0 },
    });

    const exportsDir = join(scratch, 'exports');
    const [folder] = readdirSync(exportsDir);
    expect(folder).toBe('20261124T103000Z');
    expect(statSync(join(exportsDir, folder ?? '', 'ledger.json')).mode & 0o777).toBe(0o600);
    expect(complete).not.toHaveBeenCalled();
  });

  it('answers S-80 when Telegram keeps refusing a document', async () => {
    api.refuseNextDocuments(3, 500);

    api.push(updates.text({ chatId: PRINCIPAL }, '/exportar'));

    const sent = await api.waitForSent(2, 5000);
    expect(sent.map((message) => message.text)).toEqual([
      'Aquí tienes tus datos: gastos, líneas de compra y pendientes de confirmar, en CSV y en JSON.',
      'No he podido exportar tus datos. Inténtalo de nuevo en un rato.',
    ]);
    expect(api.documents).toEqual([]);
  });

  it('answers S-80 when the export cannot be written, logging no path', async () => {
    // A file where the exports folder goes.
    writeFileSync(join(scratch, 'exports'), '');

    api.push(updates.text({ chatId: PRINCIPAL }, '/exportar'));

    const [reply] = await api.waitForSent(1);
    expect(reply?.text).toBe('No he podido exportar tus datos. Inténtalo de nuevo en un rato.');
    expect(api.documents).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith('the ledger export failed', {
      reason: expect.any(String),
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(scratch);
  });
});
