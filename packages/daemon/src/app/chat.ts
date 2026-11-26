import { basename, dirname } from 'node:path';
import {
  type ButtonHandler,
  type ButtonPress,
  type ComputerRequest,
  type DoorReply,
  type PrincipalText,
  type ScreenQuestion,
  strings,
  type TextHandler,
} from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { Config } from '../config.ts';
import { createConnectionSession, type Door, type Later } from '../connections/session.ts';
import type { ConnectionTasks } from '../connections/task.ts';
import {
  buttonTurn,
  type RecentTurns,
  receiptTurn,
  recordingTurns,
} from '../conversation/recent-turns.ts';
import { pressedOption } from '../decisions/answer.ts';
import { type RowOption, rowButton, rowLabel } from '../decisions/window-amend.ts';
import type { ReceiptExpenseCycle } from '../expenses/receipt-expense.ts';
import type { ChatHandlers } from '../local-channel/server.ts';
import type { Logger } from '../processor/ports.ts';
import { groundedRoutes } from '../routing/grounded-route.ts';
import { appSetupGuide, type SetupGap, setupGuide } from '../setup/setup-guide.ts';
import { exportLedger } from '../store/export.ts';
import type { ActionRecord } from '../store/history.ts';
import { grantConnectionTool } from '../store/permissions.ts';
import { doorOf, isExport, isStart } from './commands.ts';
import { type oneTurnAtATime, sayingStopped, settled } from './turns.ts';

export interface ChatDeps {
  config: Config;
  db: Database.Database;
  turns: RecentTurns;
  /** The chat's turns, one at a time. */
  chatTurns: ReturnType<typeof oneTurnAtATime>;
  setupGaps: () => Promise<readonly SetupGap[]>;
  onText: TextHandler;
  onButton: ButtonHandler;
  receipts: ReceiptExpenseCycle;
  recordedScreen: (question: ScreenQuestion) => Promise<DoorReply>;
  planStep: (request: ComputerRequest) => Promise<DoorReply>;
  keep: (record: Omit<ActionRecord, 'endedAt'>) => void;
  connectionTasks: ConnectionTasks;
  send: (message: DoorReply) => Promise<void>;
  now: () => Date;
  logger: Logger;
}

/**
 * What every front door calls (DK-4 AC1), in the chat's turn: the handlers both doors share, the
 * task with connections that runs beside them, and what only one door asks for.
 */
export const createChat = ({
  config,
  db,
  turns,
  chatTurns,
  setupGaps,
  onText,
  onButton,
  receipts,
  recordedScreen,
  planStep,
  keep,
  connectionTasks,
  send,
  now,
  logger,
}: ChatDeps) => {
  const { inTurn } = chatTurns;
  // DK-13, security audit M5: a route starts only when its task is the principal's own words.
  const recordedText = recordingTurns(
    turns,
    (message: PrincipalText) => message.text,
    sayingStopped(groundedRoutes(onText, logger)),
    (message) => doorOf(message.channelRef),
  );
  // A press is kept at the door it was made at: a stored Telegram reply can be pressed in the app.
  const recordedButton = (door: Door) =>
    recordingTurns(
      turns,
      (press: ButtonPress) => buttonTurn(pressedOption(db, press.data)),
      onButton,
      () => door,
    );
  const recordedReceipt = recordingTurns(
    turns,
    (receipt) => receiptTurn(receipt.caption),
    receipts.onReceipt,
    (receipt) => doorOf(receipt.channelRef),
  );
  /**
   * R-28 AC4: the guide while setup is incomplete. The check runs before the turn, so a slow
   * provider never holds it (T14); inputs that wait for the same check keep their order. B84:
   * closing the turns refuses an input still in its check at once, as one waiting for its turn,
   * so a crash leaves a Telegram text for after the restart.
   */
  const guided = <I, R>(handler: (input: I) => Promise<R>, door: Door | ((input: I) => Door)) => {
    // DK-23 AC5: each door gets the guide in its own words.
    const guideAt = (input: I, gaps: readonly SetupGap[]) =>
      (typeof door === 'function' ? door(input) : door) === 'app'
        ? appSetupGuide(gaps)
        : setupGuide(gaps);
    const turn = inTurn(async ({ input, gaps }: { input: I; gaps: readonly SetupGap[] }) =>
      gaps.length > 0 ? { text: guideAt(input, gaps) } : handler(input),
    );
    return async (input: I) => turn({ input, gaps: await chatTurns.beforeTurn(setupGaps()) });
  };
  const byChannelRef = ({ channelRef }: { channelRef: string }) => doorOf(channelRef);

  // DK-11: one task with connections at a time, its steps outside the chat's turn (session.ts).
  const connectionSession = createConnectionSession({
    tasks: connectionTasks,
    turnLock: chatTurns,
    turns,
    keep,
    send: (message) => send(message),
    // DK-24 AC1: the principal's press on "Permitir siempre", where they pressed it.
    grant: (call, door) => {
      grantConnectionTool(db, call, door, now().toISOString());
    },
    logger,
  });

  const onButtonAt = (door: Door) => {
    const pressed = guided(async (press: ButtonPress) => {
      const answer = connectionSession.answer(press.data, door);
      return answer === undefined ? recordedButton(door)(press) : answer;
    }, door);
    return async (press: ButtonPress) => settled(await pressed(press));
  };
  // DK-17 AC6: "Deshacer" and "Corregir" on a row of "Gastos" press the expense's own button
  // (R-7 AC4 to AC8) in the chat's turn, as a press at the app's door: same answer, same turn.
  const pressRow = (option: RowOption) => {
    const pressed = guided(
      recordingTurns(
        turns,
        () => buttonTurn(rowLabel(option)),
        async (expenseId: number) => {
          const at = now().toISOString();
          const data = rowButton(db, { expenseId, option, now: at });
          if (data !== null) return onButton({ data, channelRef: 'desktop:gastos', pressedAt: at });
          // R-7 AC8: undone or corrected meanwhile, or never an expense: S-19, nothing changes.
          logger.info('row press for an expense no longer current', { expenseId });
          return { text: strings.decisionClosed() };
        },
        () => 'app',
      ),
      'app',
    );
    return async (expenseId: number) => settled(await pressed(expenseId));
  };
  const onConnectAt = (door: Door) => {
    const begun = guided(
      async (task: string) =>
        task === '' ? { text: strings.connectionUsage() } : connectionSession.run(task, door),
      door,
    );
    return async (task: string) => settled(await begun(task));
  };
  const connectFromApp = onConnectAt('app');
  const connectFromTelegram = onConnectAt('telegram');
  const answered = guided(async (message: PrincipalText): Promise<DoorReply | Later | null> => {
    if (isStart(message.text)) return { text: strings.hello() };
    // R-29 AC4: Telegram handles `/exportar` before this; the app gets S-81.
    if (isExport(message.text)) return { text: strings.exportOnlyInTelegram() };
    const reply = await recordedText(message);
    // DK-13 AC2: a task with connections asked in words runs as one asked with `connect`.
    const { route } = reply;
    if (route?.to !== 'connect') return reply;
    // Telegram's answer goes out by itself when the task ends: the announcement goes now.
    // DK-16 AC1: its words are stored once, with the announcement, above.
    const run = connectionSession.run(route.task, doorOf(message.channelRef), true);
    return run ?? { text: reply.text };
  }, byChannelRef);

  // R-29 AC3: the ledger's files, sent by Telegram after S-79; no processor call.
  const exportFromTelegram = guided(async (): Promise<DoorReply> => {
    try {
      const { files } = exportLedger(db, dirname(config.dbPath), now());
      return {
        text: strings.exportSent(),
        files: files.map((path) => ({ path, name: basename(path) })),
        // R-29 AC3: a file Telegram still refuses gets S-80 too.
        filesFailed: strings.exportFailed(),
      };
    } catch (error) {
      // The error's message names the folder, and the path may name the principal: only its code.
      logger.error('the ledger export failed', {
        reason:
          (error as NodeJS.ErrnoException).code ??
          (error instanceof Error ? error.name : 'unknown'),
      });
      return { text: strings.exportFailed() };
    }
  }, 'telegram');

  const chat: ChatHandlers = {
    onText: async (message) => settled(await answered(message)),
    onReceipt: guided(recordedReceipt, byChannelRef),
    onButton: onButtonAt('telegram'),
    onScreen: guided(recordedScreen, 'app'),
    onComputer: guided(planStep, 'app'),
    onConnect: (request) => connectFromApp(request.task),
  };

  return {
    chat,
    connectionSession,
    onButtonAt,
    pressRow,
    connectFromTelegram,
    exportFromTelegram,
  };
};
