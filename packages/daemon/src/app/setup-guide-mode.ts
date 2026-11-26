import { type DoorReply, setLocale } from '@anomander/protocol';
import { createTelegramLogin } from '../auth/telegram-login.ts';
import type { Config } from '../config.ts';
import { TAKEN_BY_LOGIN } from '../local-channel/server.ts';
import type { Logger } from '../processor/ports.ts';
import { probeWithoutModel } from '../setup/model-probe.ts';
import { appSetupGuide, describeGap, type SetupGap, setupGuide } from '../setup/setup-guide.ts';
import { acquireDaemonLock } from '../store/daemon-lock.ts';
import { openTelegramDoor } from '../telegram-door.ts';
import { startChannel } from './local-channel.ts';
import { watchingPastes } from './login-waits.ts';
import type { Anomander, LoginDeps } from './types.ts';

/**
 * Logs the gaps in English and sends the guide, once the bot listens (R-28 AC3). Without
 * Telegram nothing is sent: the app's chat answers every message with the guide anyway.
 */
export const announceGaps = async (
  gaps: readonly SetupGap[],
  send: ((message: DoorReply) => Promise<void>) | undefined,
  logger: Logger,
): Promise<void> => {
  if (gaps.length === 0) return;
  for (const gap of gaps) logger.warn(`setup incomplete: ${describeGap(gap)}`);
  await send?.({ text: setupGuide(gaps) }).catch((error: unknown) => {
    logger.error('Could not send the setup guide', { error });
  });
};

export interface SetupGuideDeps {
  /** The model gaps `resolveModels` found: never empty. */
  gaps: readonly SetupGap[];
  login?: LoginDeps;
  telegramApiRoot?: string;
  logger?: Logger;
}

/**
 * R-28: the bot that runs while `.env` names no usable model. It answers everything with the
 * guide, except `/login` and `/logout` (R-17 AC7), in Telegram and in the desktop app's chat; no
 * processor, store, scheduled job or read API runs.
 */
export const startSetupGuide = (config: Config, deps: SetupGuideDeps): Anomander => {
  // Before any text is built: the guide below is written once, in this language.
  setLocale(config.locale);
  const { gaps, logger = console } = deps;
  // DK-2 AC1: no store runs here, but the daemon is still the only one of its data folder.
  const lock = acquireDaemonLock(config.dbPath);
  const guide = { text: setupGuide(gaps) };
  // DK-23 AC5: the app's chat gets the guide about its window.
  const appGuide = { text: appSetupGuide(gaps) };
  let send = async (_: DoorReply): Promise<void> => {
    throw new Error('send used before the bot was created');
  };
  let deleteMessage = async (_: string): Promise<void> => {
    throw new Error('deleteMessage used before the bot was created');
  };
  // B81: bound below, once the local channel exists.
  let loginWaiting = (_: boolean): void => {};
  // R-27: a login is made in Telegram only; the app has its Suscripciones screen (DK-15).
  const login =
    deps.login === undefined || config.telegram === undefined
      ? undefined
      : createTelegramLogin({
          ...deps.login,
          // B81 (DK-4 AC7): the app's windows are told while it waits for a pasted text.
          models: watchingPastes(deps.login.models, (waiting) => loginWaiting(waiting)),
          send: (message) => send(message),
          deleteMessage: (channelRef) => deleteMessage(channelRef),
          logger,
        });
  const telegram = openTelegramDoor(
    config.telegram,
    {
      onText: async (message) => {
        const handled = await login?.handleText(message);
        return handled === undefined ? guide : handled.reply;
      },
      onReceipt: async () => guide,
      onButton: async (press) => {
        const handled = await login?.handleButton(press);
        return handled === undefined ? guide : handled.reply;
      },
    },
    { logger, apiRoot: deps.telegramApiRoot },
  );
  send = telegram.send;
  deleteMessage = telegram.deleteMessage;
  const localChannel = startChannel(
    config,
    {
      // R-17 AC7: a code pasted in the app's chat while a login waits goes to it, never stored.
      onText: async (message) =>
        login?.takePasted(message.text) === true ? TAKEN_BY_LOGIN : appGuide,
      onReceipt: async () => appGuide,
      onButton: async () => appGuide,
      onScreen: async () => appGuide,
      onComputer: async () => appGuide,
      onConnect: async () => appGuide,
    },
    // No store runs here: the app's chat starts empty, and an erase cannot be done yet.
    {
      messages: () => [],
      clear: () => {
        throw new Error('the setup guide opens no database');
      },
    },
    {
      memories: () => [],
      actions: () => [],
      forgetMemory: () => {
        throw new Error('the setup guide opens no database');
      },
      forgetAction: () => {
        throw new Error('the setup guide opens no database');
      },
    },
    // DK-17: nor can expenses be read or changed: the window says it could not (S-22).
    {
      month: () => {
        throw new Error('the setup guide opens no database');
      },
      undo: () => {
        throw new Error('the setup guide opens no database');
      },
      correct: () => {
        throw new Error('the setup guide opens no database');
      },
    },
    logger,
    undefined,
    // DK-24: the setup guide holds no grants.
    undefined,
    // DK-23 AC4: no model can be called; the probe says why.
    async () => probeWithoutModel(gaps, config),
  );
  loginWaiting = (waiting) => localChannel?.loginWaiting(waiting);

  // A failed start is the caller's to report, through `started`.
  telegram.started.then(
    () => announceGaps(gaps, config.telegram === undefined ? undefined : send, logger),
    () => {},
  );
  // B51: what `halt` began, `stop` waits for.
  let doorsClosing: Promise<void> | undefined;
  const halt = (): Promise<void> => {
    if (doorsClosing !== undefined) return doorsClosing;
    login?.stop();
    doorsClosing = (async () => {
      await localChannel?.stop();
      await telegram.stop();
    })();
    doorsClosing.catch(() => {});
    return doorsClosing;
  };
  return {
    started: telegram.started,
    polling: telegram.ended,
    readApi: undefined,
    localChannel: localChannel?.listening,
    halt: () => halt().catch(() => {}),
    stop: async () => {
      await halt();
      lock.release();
    },
  };
};
