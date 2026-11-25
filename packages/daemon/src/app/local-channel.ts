import type { ProbeOutcome } from '@anomander/protocol';
import type { Config } from '../config.ts';
import {
  type ChatHandlers,
  type ConnectionGrants,
  type ExpensesLedger,
  type LocalChannel,
  type StoredConversation,
  type StoredMemory,
  startLocalChannel,
} from '../local-channel/server.ts';
import type { Logger } from '../processor/ports.ts';

/** DK-3: the desktop app's front door, only while `ANOMANDER_LOCAL_TOKEN` is set. */
export const startChannel = (
  config: Config,
  handlers: ChatHandlers,
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
