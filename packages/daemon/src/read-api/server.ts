import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../processor/text-interpreter.ts';
import { isDay, openReadOnly, readGastos, readLineas, readPendientes } from './queries.ts';

// RA-2 (docs/read-access-prd.md): the views of RA-1 over HTTP, read only, behind a bearer token.
// `startAnomander` starts it only while `ANOMANDER_API_TOKEN` is set (AC1).

export interface ReadApiDeps {
  /** The SQLite file, already migrated; the API opens its own read-only connection to it. */
  dbPath: string;
  /** `ANOMANDER_API_TOKEN`: never logged (AC2). */
  token: string;
  host: string;
  /** `0` lets the system pick a free port, as tests do. */
  port: number;
  logger: Logger;
}

export interface ReadApiAddress {
  host: string;
  port: number;
}

export interface ReadApi {
  /** Resolves once the API listens; rejects when it cannot, for example a port in use. */
  listening: Promise<ReadApiAddress>;
  stop(): Promise<void>;
}

const BAD_RANGE = 'desde and hasta must both be days as YYYY-MM-DD';

/** A SHA-256 digest, so the comparison below takes the same time whatever the lengths. */
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
};

export const startReadApi = (deps: ReadApiDeps): ReadApi => {
  const { logger } = deps;
  const db = openReadOnly(deps.dbPath);
  const expected = digest(`Bearer ${deps.token}`);
  // AC2: the whole header against `Bearer <token>`, in constant time.
  const authorized = (header: string | undefined): boolean =>
    header !== undefined && timingSafeEqual(digest(header), expected);

  /** The rows a GET asks for, or the status and error it gets instead. */
  const answer = (url: URL): [number, unknown] => {
    const desde = url.searchParams.get('desde');
    const hasta = url.searchParams.get('hasta');
    switch (url.pathname) {
      case '/v1/gastos':
        return isDay(desde) && isDay(hasta)
          ? [200, readGastos(db, { desde, hasta })]
          : [400, { error: BAD_RANGE }];
      case '/v1/lineas': {
        if (!isDay(desde) || !isDay(hasta)) return [400, { error: BAD_RANGE }];
        const producto = url.searchParams.get('producto');
        return [200, readLineas(db, { desde, hasta, ...(producto === null ? {} : { producto }) })];
      }
      case '/v1/pendientes':
        return [200, readPendientes(db)];
      default:
        return [404, { error: 'not found' }];
    }
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    // The token is checked before anything else, so a caller without it learns nothing.
    if (!authorized(request.headers.authorization)) {
      send(response, 401, { error: 'unauthorized' });
      return;
    }
    // AC4: only GET; nothing else runs, and the connection is read-only anyway.
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      send(response, 405, { error: 'method not allowed' });
      return;
    }
    const target = request.url ?? '/';
    // A target Node accepted and `URL` does not (`//[`): an answer, never an uncaught error.
    if (!URL.canParse(target, 'http://read-api')) {
      send(response, 400, { error: 'bad request' });
      return;
    }
    const url = new URL(target, 'http://read-api');
    try {
      const [status, body] = answer(url);
      send(response, status, body);
    } catch (error) {
      // AC5: the path only, never the query, the token or a body.
      logger.error(`read API failed to answer GET ${url.pathname}`, { error });
      send(response, 500, { error: 'internal error' });
    }
  };

  const server = createServer(handle);
  const listening = new Promise<ReadApiAddress>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, deps.host, () => {
      server.off('error', reject);
      server.on('error', (error) => logger.error('read API server error', { error }));
      const { address, port } = server.address() as AddressInfo;
      resolve({ host: address, port });
    });
  });

  return {
    listening,
    stop: async () => {
      if (server.listening) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
      db.close();
    },
  };
};
