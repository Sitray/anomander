import { mkdtempSync, rmSync } from 'node:fs';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeTelegramApi, startFakeTelegramApi } from '@anomander/telegram/fake-telegram-api';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/store/database.ts';

// RA-2 (docs/read-access-prd.md): real HTTP requests against the read API of a started daemon,
// with the fake Telegram API and a SQLite file in a `mkdtemp` folder, as in `test/e2e/`.
const PRINCIPAL = 4242;
const TOKEN = 'read-api-test-token-7Kq2';
const NOW = '2026-11-10T10:00:00.000Z';

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander | undefined;
let writer: Database.Database | undefined;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };

const dbPath = () => join(scratch, 'anomander.db');

/** Starts the daemon; the API, when on, listens on a free port so tests never use 4311. */
const start = async (env: Record<string, string> = {}): Promise<Anomander> => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: dbPath(),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
    ...env,
  });
  anomander = startAnomander(
    { ...config, apiPort: 0 },
    {
      complete: async () => {
        throw new Error('the read API makes no processor call');
      },
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger,
    },
  );
  await anomander.started;
  return anomander;
};

/** The base URL of a started read API. */
const readApi = async (): Promise<string> => {
  const address = await start({ ANOMANDER_API_TOKEN: TOKEN }).then((daemon) => daemon.readApi);
  if (address === undefined) throw new Error('the read API did not start');
  return `http://${address.host}:${address.port}`;
};

const get = (url: string, authorization: string | null = `Bearer ${TOKEN}`) =>
  fetch(url, authorization === null ? {} : { headers: { authorization } });

/** A second, writable connection, as the daemon's own cycles would write. */
const store = (): Database.Database => {
  writer ??= openDatabase(dbPath());
  return writer;
};

interface Seed {
  fecha: string;
  total_cents: number;
  merchant?: string;
  category?: string;
  status?: 'current' | 'pending' | 'refuted';
  /** A receipt's lines; an expense without them is a text expense. */
  lines?: [string, number, number][];
}

const expense = (seed: Seed): number => {
  const db = store();
  const documentId =
    seed.lines === undefined
      ? null
      : db
          .prepare(
            `INSERT INTO documents (kind, received_at, source, status)
             VALUES ('receipt', ?, 'telegram:1', 'read')`,
          )
          .run(NOW).lastInsertRowid;
  const merchantId =
    seed.merchant === undefined
      ? null
      : db
          .prepare("INSERT INTO entities (kind, name, created_at) VALUES ('merchant', ?, ?)")
          .run(seed.merchant, NOW).lastInsertRowid;
  const id = Number(
    db
      .prepare(
        `INSERT INTO expenses (merchant_id, occurred_on, total_cents, category_id, mode,
           document_id, status, created_at)
         VALUES (?, ?, ?, (SELECT id FROM categories WHERE name = ?), ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        seed.fecha,
        seed.total_cents,
        seed.category ?? null,
        documentId === null ? 'declared' : 'corroborated',
        documentId,
        seed.status ?? 'current',
        NOW,
      ).lastInsertRowid,
  );
  for (const [name, quantity, amount] of seed.lines ?? []) {
    db.prepare(
      'INSERT INTO purchase_lines (expense_id, product_name, quantity, amount_cents) VALUES (?, ?, ?, ?)',
    ).run(id, name, quantity, amount);
  }
  return id;
};

/** Every row of every table, to show a request changed nothing. */
const snapshot = (): Record<string, unknown[]> => {
  const db = store();
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_search%' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]),
  );
};

const logged = () =>
  JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-read-api-'));
  api = await startFakeTelegramApi();
  logger = { info: vi.fn<Log>(), warn: vi.fn<Log>(), error: vi.fn<Log>() };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await anomander?.stop();
  anomander = undefined;
  writer?.close();
  writer = undefined;
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the read API (RA-2)', () => {
  it('AC1: with no ANOMANDER_API_TOKEN, or an empty one, the daemon starts and opens no port', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen');

    const daemon = await start();
    expect(daemon.readApi).toBeUndefined();
    await daemon.stop();

    const empty = await start({ ANOMANDER_API_TOKEN: '' });
    expect(empty.readApi).toBeUndefined();
    expect(listen).not.toHaveBeenCalled();
  });

  it('AC3: binds to 127.0.0.1 when ANOMANDER_API_HOST is unset', async () => {
    const base = await readApi();
    expect(new URL(base).hostname).toBe('127.0.0.1');
  });

  it('AC2: a request with no bearer token, or another one, gets 401 and no data; the token is never logged', async () => {
    const base = await readApi();
    expense({ fecha: '2026-11-10', total_cents: 2300, category: 'restaurantes' });
    const url = `${base}/v1/gastos?desde=2026-11-01&hasta=2026-11-30`;

    for (const authorization of [
      null,
      'Bearer wrong',
      `Bearer ${TOKEN}x`,
      TOKEN,
      `Basic ${TOKEN}`,
    ]) {
      const response = await get(url, authorization);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
    for (const path of ['/v1/pendientes', '/v1/lineas?desde=2026-11-01&hasta=2026-11-30']) {
      expect((await get(`${base}${path}`, 'Bearer wrong')).status).toBe(401);
    }

    const allowed = await get(url);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toHaveLength(1);
    expect(logged()).not.toContain(TOKEN);
  });

  it('AC4: any method but GET gets 405 and leaves the database unchanged', async () => {
    const base = await readApi();
    expense({ fecha: '2026-11-10', total_cents: 2300, category: 'restaurantes' });
    expense({
      fecha: '2026-11-10',
      total_cents: 1000,
      merchant: 'Lidl',
      status: 'pending',
      lines: [['AGUA', 1, 1000]],
    });
    const before = snapshot();

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await fetch(`${base}/v1/gastos?desde=2026-11-01&hasta=2026-11-30`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}` },
        ...(['POST', 'PUT', 'PATCH'].includes(method) ? { body: '{"total_cents": 1}' } : {}),
      });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
      expect(await response.text()).toBe(method === 'HEAD' ? '' : '{"error":"method not allowed"}');
    }
    expect(snapshot()).toEqual(before);
  });

  it('AC5: answers the matching view rows as JSON, days inclusive and producto exact, and logs no body', async () => {
    const base = await readApi();
    expense({ fecha: '2026-10-31', total_cents: 900, category: 'restaurantes' });
    const cena = expense({ fecha: '2026-11-01', total_cents: 2300, category: 'restaurantes' });
    const mercadona = expense({
      fecha: '2026-11-05',
      total_cents: 450,
      merchant: 'Mercadona',
      category: 'supermercado',
      lines: [
        ['LECHE ENTERA', 2, 190],
        ['PAN', 1, 260],
      ],
    });
    const later = expense({
      fecha: '2026-11-06',
      total_cents: 95,
      merchant: 'Dia',
      lines: [['LECHE ENTERA', 1, 95]],
    });
    expense({
      fecha: '2026-11-02',
      total_cents: 1000,
      merchant: 'Lidl',
      status: 'pending',
      lines: [['AGUA', 1, 1000]],
    });
    expense({ fecha: '2026-11-03', total_cents: 500, status: 'pending' });

    const gastos = await get(`${base}/v1/gastos?desde=2026-11-01&hasta=2026-11-05`);
    expect(gastos.status).toBe(200);
    expect(gastos.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await gastos.json()).toEqual([
      {
        id: cena,
        fecha: '2026-11-01',
        comercio: null,
        categoria: 'restaurantes',
        total_cents: 2300,
        modo: 'declared',
        origen: 'texto',
      },
      {
        id: mercadona,
        fecha: '2026-11-05',
        comercio: 'Mercadona',
        categoria: 'supermercado',
        total_cents: 450,
        modo: 'corroborated',
        origen: 'ticket',
      },
    ]);

    const leche = await get(
      `${base}/v1/lineas?desde=2026-11-01&hasta=2026-11-30&producto=${encodeURIComponent('LECHE ENTERA')}`,
    );
    expect(leche.status).toBe(200);
    expect(await leche.json()).toEqual([
      {
        gasto_id: mercadona,
        producto: 'LECHE ENTERA',
        cantidad: 2,
        precio_cents: 190,
        comercio: 'Mercadona',
        categoria: 'supermercado',
        fecha: '2026-11-05',
        modo: 'corroborated',
      },
      {
        gasto_id: later,
        producto: 'LECHE ENTERA',
        cantidad: 1,
        precio_cents: 95,
        comercio: 'Dia',
        categoria: null,
        fecha: '2026-11-06',
        modo: 'corroborated',
      },
    ]);
    const inexact = await get(`${base}/v1/lineas?desde=2026-11-01&hasta=2026-11-30&producto=leche`);
    expect(await inexact.json()).toEqual([]);
    const lines = await get(`${base}/v1/lineas?desde=2026-11-05&hasta=2026-11-05`);
    expect((await lines.json()).map((line: { producto: string }) => line.producto)).toEqual([
      'LECHE ENTERA',
      'PAN',
    ]);

    const pendientes = await get(`${base}/v1/pendientes`);
    expect(pendientes.status).toBe(200);
    expect(await pendientes.json()).toEqual({ cantidad: 2, total_cents: 1500 });

    expect(logged()).not.toMatch(/Mercadona|LECHE|restaurantes/);
  });

  it('A1: a missing or malformed desde or hasta gets 400 and no data', async () => {
    const base = await readApi();
    expense({ fecha: '2026-11-10', total_cents: 2300, category: 'restaurantes' });

    for (const query of [
      '',
      '?desde=2026-11-01',
      '?hasta=2026-11-30',
      '?desde=2026-11-1&hasta=2026-11-30',
      '?desde=2026-02-30&hasta=2026-11-30',
      '?desde=2026-11-01&hasta=mañana',
    ]) {
      for (const path of ['/v1/gastos', '/v1/lineas']) {
        const response = await get(`${base}${path}${query}`);
        expect(response.status, `${path}${query}`).toBe(400);
        expect(await response.json()).toEqual({
          error: 'desde and hasta must both be days as YYYY-MM-DD',
        });
      }
    }
  });
});
