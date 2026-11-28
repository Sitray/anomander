import type Database from 'better-sqlite3';
import type { Config } from '../config.ts';
import { readConnections } from '../connections/config.ts';
import { createConnections } from '../connections/mcp-client.ts';
import { oauthKeeperFrom, printOAuthForShell } from '../connections/oauth.ts';
import { createConnectionTasks, type DecidedCall } from '../connections/task.ts';
import type { Complete, Logger } from '../processor/ports.ts';
import { connectionToolGranted, revokeConnectionToolsNotIn } from '../store/permissions.ts';
import type { AnomanderDeps } from './types.ts';

export interface ConnectionsDeps<M> {
  config: Config;
  db: Database.Database;
  deps: Pick<AnomanderDeps<M>, 'connections' | 'connectionProblems' | 'printOAuth'>;
  /** The budgeted processor call. */
  ai: Complete<M>;
  model: M;
  decided: (call: DecidedCall) => void;
  now: () => Date;
  logger: Logger;
}

/** The servers of `mcp.json` and the tasks that use them (DK-11, DK-24). */
export const setUpConnections = <M>({
  config,
  db,
  deps,
  ai,
  model,
  decided,
  now,
  logger,
}: ConnectionsDeps<M>) => {
  // DK-11: a task with the servers the principal connected. The processor asks for calls and
  // `connectionTasks` decides each one; a call that needs permission comes back with buttons.
  const read =
    deps.connections === undefined
      ? readConnections(config.mcpConfigPath, logger, config.mcpSecrets)
      : undefined;
  // DK-24 AC2, AC3: a "Permitir siempre" holds only for its server as `mcp.json` has it now, so
  // one of a server removed, renamed or changed is revoked at the start; a file that cannot be
  // read changes none.
  if (read !== undefined && !read.invalid) {
    // B67: one that cannot be read grants nothing; said once per start, by its id only.
    const revoked = revokeConnectionToolsNotIn(db, read.identities, now().toISOString(), (id) =>
      logger.warn('a connection grant cannot be read; it grants nothing', { id }),
    );
    if (revoked > 0) logger.info(`revoked ${revoked} connection grants of changed servers`);
  }
  const servers =
    read === undefined
      ? undefined
      : createConnections({
          config: read.config,
          identities: read.identities,
          logger,
          oauth: oauthKeeperFrom(config.mcpOAuth, deps.printOAuth ?? printOAuthForShell(), logger),
        });
  const connectionTasks = createConnectionTasks({
    complete: ai,
    model,
    connections: deps.connections ?? (async () => (await servers?.get()) ?? []),
    problems:
      deps.connectionProblems ??
      (() => ({
        invalid: read?.invalid ?? false,
        unreachable: [...(read?.leftOut ?? []), ...(servers?.unreachable() ?? [])],
      })),
    logger,
    // DK-14 AC2: which calls were sent or refused, never their arguments or results.
    decided,
    // DK-24: code checks the principal's grant, never the processor.
    alwaysAllowed: (call) => connectionToolGranted(db, call),
  });

  return { servers, connectionTasks };
};
