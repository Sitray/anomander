import {
  type ComputerRequest,
  type DoorReply,
  MAX_COMPUTER_STEPS,
  type ScreenQuestion,
  strings,
} from '@anomander/protocol';
import type Database from 'better-sqlite3';
import {
  computerTurn,
  type RecentTurns,
  recordingTurns,
  screenTurn,
} from '../conversation/recent-turns.ts';
import { turnStopped } from '../processor/cancel.ts';
import { createPiAiComputerPlanner } from '../processor/computer-planner.ts';
import type { Complete, Logger } from '../processor/ports.ts';
import { createPiAiScreenReader } from '../processor/screen-reader.ts';
import { type ActionRecord, recordAction } from '../store/history.ts';
import { memoryNotesFor } from '../store/memory.ts';
import { sayingStopped } from './turns.ts';
import type { AnomanderDeps } from './types.ts';

export interface AppTasksDeps<M> {
  db: Database.Database;
  /** The budgeted processor call. */
  ai: Complete<M>;
  deps: Pick<AnomanderDeps<M>, 'visionModel'>;
  model: M;
  turns: RecentTurns;
  now: () => Date;
  logger: Logger;
}

/**
 * What only the app asks for: a look at the screen and the steps of a task on the computer, and
 * the history of what ANOMANDER did (DK-14), which a task with connections keeps too.
 */
export const createAppTasks = <M>({ db, ai, deps, model, turns, now, logger }: AppTasksDeps<M>) => {
  // DK-14 AC2: each action is kept once it ended. A failure to keep it never changes the reply,
  // and is logged without the principal's words (AC5).
  const keep = (record: Omit<ActionRecord, 'endedAt'>): void => {
    try {
      recordAction(db, { ...record, endedAt: now().toISOString() });
    } catch (error) {
      logger.error('action history not saved', {
        kind: record.kind,
        reason: (error as Error).message,
      });
    }
  };

  // A look at the screen: the budgeted call, so it counts against the daily cap (R-12).
  const screenReader = createPiAiScreenReader({
    complete: ai,
    model: deps.visionModel ?? model,
    logger,
  });
  const recordedScreen = recordingTurns(
    turns,
    (question: ScreenQuestion) => screenTurn(question.text),
    sayingStopped(async (question: ScreenQuestion): Promise<DoorReply> => {
      const reading = await screenReader({
        question: question.text,
        image: question.image,
        memories: memoryNotesFor(db, question.text),
      });
      // DK-14 AC2: the question only, never the capture or what was read in it.
      keep({
        kind: 'screen',
        door: 'app',
        task: question.text,
        // DK-19: a look stopped from the app is kept as stopped, not as failed.
        outcome: turnStopped() ? 'cancelled' : reading.kind,
        steps: null,
        calls: null,
      });
      switch (reading.kind) {
        case 'answer':
          return { text: reading.text };
        case 'budget_exhausted':
          return { text: strings.textLimitReached() };
        case 'provider_limit':
          return { text: strings.providerLimitReached() };
        case 'failed':
          return { text: strings.screenNotSeen() };
      }
    }),
    () => 'app',
  );

  // DK-10: the next step of a task on the computer. The budgeted call, as a look at the screen.
  const computerPlanner = createPiAiComputerPlanner({
    complete: ai,
    model: deps.visionModel ?? model,
    logger,
  });
  const planStep = async (request: ComputerRequest): Promise<DoorReply> => {
    // DK-14 AC2: how a task ended and how many steps it took, never what they typed or pressed.
    const ended = (outcome: string) =>
      keep({
        kind: 'computer',
        door: 'app',
        task: request.task,
        outcome,
        steps: request.done.length,
        calls: null,
      });
    // AC4: a task that long is stopped here, whatever the app does.
    if (request.done.length >= MAX_COMPUTER_STEPS) {
      ended('too_many_steps');
      return { text: strings.computerTooManySteps(MAX_COMPUTER_STEPS) };
    }
    const plan = await computerPlanner({
      ...request,
      memories: memoryNotesFor(db, request.task),
    });
    if (plan.kind === 'end') ended(plan.completed ? 'done' : 'cannot');
    else if (plan.kind !== 'action') ended(plan.kind);
    switch (plan.kind) {
      case 'action':
        return { text: plan.text, computer: plan.action, confirm: plan.confirm };
      case 'end':
        // R-16 AC3: how the task ended is a recent turn; its steps are not.
        return turns.add(computerTurn(request.task), { text: plan.text }, 'app');
      case 'budget_exhausted':
        return { text: strings.textLimitReached() };
      case 'provider_limit':
        return { text: strings.providerLimitReached() };
      case 'failed':
        return { text: strings.computerFailed() };
    }
  };

  return { keep, recordedScreen, planStep };
};
