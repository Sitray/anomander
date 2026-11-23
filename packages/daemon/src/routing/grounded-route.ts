import { type RouteKind, strings, type TextHandler } from '@anomander/protocol';

// DK-13, security audit M5: the processor writes a route's task, and it also reads the recent
// turns, the memories and the history. The prompt tells it to take the task only from the
// message; code checks it, so nothing it read elsewhere can become a look, a task on the
// computer or a task with connections.

/** The words of a text, lower-cased and without accents: runs of letters or digits. */
const wordsOf = (text: string): string[] =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('es-ES')
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Words that turn a request around: a task that drops one asks for the opposite. In Spanish and
 * in English, whatever language the daemon speaks: `t` is what is left of "don't" or "can't",
 * and the contractions are also listed as written without their apostrophe.
 */
const NEGATIONS = [
  'no',
  'nunca',
  'jamas',
  'not',
  'never',
  't',
  'cannot',
  'dont',
  'doesnt',
  'didnt',
  'cant',
  'wont',
  'isnt',
  'arent',
  'shouldnt',
  'nor',
  'neither',
  'without',
];

/**
 * Whether every word of `task` is a word of `message`, ignoring case, accents, punctuation and
 * order, and the task keeps every negation (`NEGATIONS`) the message has. A task with no words
 * is not. The processor may drop words and reorder them, but never add one nor drop a negation:
 * whatever the task says, the principal wrote. Words are compared as written, never stemmed.
 */
export const taskInMessage = (task: string, message: string): boolean => {
  const said = new Set(wordsOf(message));
  const asked = wordsOf(task);
  const kept = new Set(asked);
  return (
    asked.length > 0 &&
    asked.every((word) => said.has(word)) &&
    NEGATIONS.every((word) => !said.has(word) || kept.has(word))
  );
};

/** What the principal reads instead of a route that was not started; it asks again in words. */
const NOT_STARTED: Record<RouteKind, () => string> = {
  screen: () => strings.computerFailed(),
  computer: () => strings.computerFailed(),
  connect: () => strings.connectionFailed(),
};

interface RouteLogger {
  warn: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Wraps the chat's text handler: a reply whose route's task is not in the principal's message
 * starts nothing. It says it could not and asks for it another way, before anything is
 * captured, planned or called. Logged with the way only: the task may be a memory's text
 * (R-23 AC8).
 */
export const groundedRoutes =
  (handler: TextHandler, logger: RouteLogger): TextHandler =>
  async (message) => {
    const reply = await handler(message);
    const { route } = reply;
    if (route === undefined || taskInMessage(route.task, message.text)) return reply;
    logger.warn('route not started: its task is not in the message', { to: route.to });
    return { text: NOT_STARTED[route.to]() };
  };
