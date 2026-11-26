import type { ProbeOutcome } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { Config } from '../config.ts';
import type { RecentTurns } from '../conversation/recent-turns.ts';
import type { RowOption } from '../decisions/window-amend.ts';
import {
  type ChannelHandlers,
  type ConnectionGrants,
  type ExpensesLedger,
  type LocalChannel,
  type StoredConversation,
  type StoredMemory,
  startLocalChannel,
} from '../local-channel/server.ts';
import type { Logger } from '../processor/ports.ts';
import { readExpensesMonth } from '../read-api/month.ts';
import { storedConversation } from '../store/conversation.ts';
import { forgetAction, listActions } from '../store/history.ts';
import { forgetMemoryAndItsTurns, listMemories } from '../store/memory.ts';
import { connectionToolGrants, revokeConnectionTool } from '../store/permissions.ts';
import type { oneTurnAtATime } from './turns.ts';

/** DK-3: the desktop app's front door, only while `ANOMANDER_LOCAL_TOKEN` is set. */
export const startChannel = (
  config: Config,
  handlers: ChannelHandlers,
  conversation: StoredConversation,
  memory: StoredMemory,
  expenses: ExpensesLedger,
  logger: Logger,
  now?: () => Date,
  grants?: ConnectionGrants,
  /** DK-23 AC4: "Probar". */
  probe?: () => Promise<ProbeOutcome>,
  /** DK-21: absent while no database is open. */
  aiUsage?: () => { calls: number; limit: number },
  /** DK-22: an app connected, so what waited for a door can go out. */
  onConnected?: () => void,
): LocalChannel | undefined =>
  config.localToken === undefined
    ? undefined
    : startLocalChannel({
        token: config.localToken,
        port: config.localPort,
        handlers,
        conversation,
        memory,
        expenses,
        logger,
        ...(now === undefined ? {} : { now }),
        ...(grants === undefined ? {} : { grants }),
        ...(probe === undefined ? {} : { probe }),
        ...(aiUsage === undefined ? {} : { aiUsage }),
        ...(onConnected === undefined ? {} : { onConnected }),
      });

export interface ChannelViewsDeps {
  config: Config;
  db: Database.Database;
  turns: RecentTurns;
  /** The chat's turn: the app's erases and forgets wait for the one that runs. */
  inTurn: ReturnType<typeof oneTurnAtATime>['inTurn'];
  /** A press on a row of "Gastos", in the chat's turn. */
  pressRow: (option: RowOption) => ExpensesLedger['undo'];
  now: () => Date;
}

/** What the app's windows read and change in the store, beside the chat (`startChannel`). */
export const channelViews = ({
  config,
  db,
  turns,
  inTurn,
  pressRow,
  now,
}: ChannelViewsDeps): {
  conversation: StoredConversation;
  memory: StoredMemory;
  expenses: ExpensesLedger;
  grants: ConnectionGrants;
} => {
  // DK-16: the app shows the stored conversation of both doors and can erase it. AC4: the erase
  // waits for the turn that runs, so nothing of that turn is stored after it.
  const clearInTurn = inTurn(async () => turns.clear());
  // DK-18: a forget from the window waits for the turn that runs too, as the erase does, so a
  // turn that says it is stored before it and goes with it. Only the turns that say it go.
  const forgetMemoryInTurn = inTurn(async (id: number) => {
    forgetMemoryAndItsTurns(db, id);
  });
  const forgetActionInTurn = inTurn(async (id: number) => {
    forgetAction(db, id);
  });
  return {
    conversation: {
      messages: (limit) => storedConversation(db, limit),
      clear: () => clearInTurn(undefined),
    },
    memory: {
      memories: () => listMemories(db),
      forgetMemory: forgetMemoryInTurn,
      actions: () =>
        listActions(db).map(({ id, kind, door, task, outcome, endedAt }) => ({
          id,
          what: kind,
          door,
          task,
          outcome,
          at: endedAt,
        })),
      forgetAction: forgetActionInTurn,
    },
    // DK-17: the "Gastos" screen, over the views of RA-1.
    expenses: {
      month: (month) => readExpensesMonth(db, { month, timeZone: config.timeZone, now: now() }),
      undo: pressRow('undo'),
      correct: pressRow('correct'),
    },
    // DK-24 AC3: the "Permitir siempre" in force, for "Conexiones", and "Quitar".
    grants: {
      list: () =>
        connectionToolGrants(db).map(({ id, server, tool, grantedAt }) => ({
          id,
          server,
          tool,
          at: grantedAt,
        })),
      revoke: (id) => revokeConnectionTool(db, id, now().toISOString()),
    },
  };
};
