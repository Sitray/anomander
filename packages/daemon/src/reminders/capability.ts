import { isCalendarDate } from '@anomander/core';
import {
  buttons,
  decisionButtons,
  type PrincipalText,
  type Reply,
  strings,
} from '@anomander/protocol';
import { z } from 'zod';
import { type CapabilityEnv, defineCapability } from '../capabilities/capability.ts';
import { checkedPhrasing } from '../processor/reply-phraser.ts';
import { openCancelReminderDecision } from '../store/decisions.ts';
import { quotedFrom } from '../store/memory.ts';
import { recordDecisionMessage } from '../store/receipts.ts';
import {
  createReminder,
  listPending,
  markDone,
  type Reminder,
  readReminder,
  recurrenceSchema,
  scheduleTask,
} from '../store/reminders.ts';
import { localParts, nextOccurrence, utcOf, whenOf } from './when.ts';

// R-25: reminders and tasks, the first capability (R-24 AC4). Creating one is the principal's own
// declaration, so it runs at once, without buttons (AC2); so does marking one done (AC10), while
// cancelling asks first (AC9). The text is never logged (AC12): log calls here carry the channel
// reference, ids and reasons only.

const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

const createSchema = z.object({
  kind: z.literal('reminder_create'),
  text: z.string().trim().min(1),
  /** R-25 AC5: the pending task that gets a time; its row and text are kept. */
  id: z.int().positive().nullable().optional(),
  /** Local `YYYY-MM-DDTHH:mm` in `TZ`; ignored when there is a repetition. */
  at: z
    .string()
    .regex(LOCAL_DATE_TIME)
    .refine((value) => isCalendarDate(value.slice(0, 10)))
    .nullable()
    .optional(),
  recurrence: recurrenceSchema.nullable().optional(),
  unsupported_recurrence: z.boolean().optional(),
  /** S-40 or S-41 worded in the same call (R-25 AC6). */
  reply: z.string().trim().min(1).optional(),
});

/** R-25 AC8: code lists what is pending; the processor never words the list. */
const listSchema = z.object({ kind: z.literal('reminder_list') });

/** R-25 AC9, AC10: the processor only picks, among the pending ones it was given. */
const cancelSchema = z.object({
  kind: z.literal('reminder_cancel'),
  ids: z.array(z.int().positive()),
});
const doneSchema = z.object({ kind: z.literal('reminder_done'), ids: z.array(z.int().positive()) });

const callSchema = z.discriminatedUnion('kind', [
  createSchema,
  listSchema,
  cancelSchema,
  doneSchema,
]);

type CreateCall = z.infer<typeof createSchema>;

const PROMPT = `If the user asks you to remind them of something ("recuérdame mañana llamar a mamá") or notes something they have to do, with or without a date ("tengo que comprar pilas"), reply:
{"kind":"reminder_create","text":"<what to remember, copied word for word from the message>","at":"<YYYY-MM-DDTHH:mm, the local time to remind them>","recurrence":null,"unsupported_recurrence":false,"reply":"<a short, friendly reply in Spanish (es-ES), at most 280 characters, saying the same as: Te lo recuerdo <cuando>: <text>.>"}
Work out "at" from the "now" and "weekday" fields of "reminders" ("mañana", "en dos horas", "el viernes"). A day without a time means 09:00.
If it repeats every day, every week on some days, or every month on one day, always at one time, set "at" to null and "recurrence" to {"freq":"daily","time":"HH:mm"}, {"freq":"weekly","days":[<1 Monday to 7 Sunday>],"time":"HH:mm"} or {"freq":"monthly","day":<1 to 31>,"time":"HH:mm"}.
If it repeats in any other way ("cada dos semanas", "el último viernes de cada mes"), set "unsupported_recurrence" to true.
If it has no date at all, set "at" and "recurrence" to null, and "reply" says the same as: Apuntado en tus pendientes: <text>.
If the user gives a time to a pending task, one whose "when" is null ("lo de las pilas, recuérdamelo el sábado"), add "id":<the "id" of that task> and copy its "text" exactly into "text".
Write <cuando> as "hoy a las 9:00", "mañana a las 9:00", "el 29 de octubre a las 9:00", "todos los días a las 9:00", "todos los lunes y jueves a las 8:00" or "el día 15 de cada mes a las 9:00", and "a la 1:00" at one o'clock. Copy <text> exactly and add no other number.
You never store the reminder: the assistant does, and sends "reply" only if it keeps the facts.

If the user asks what they have pending ("¿qué tengo pendiente?"), reply:
{"kind":"reminder_list"}
Never write the list yourself; the assistant lists them.

If the user asks to cancel a pending reminder or task ("cancela lo del dentista"), reply:
{"kind":"reminder_cancel","ids":[<the "id" of each pending reminder or task that matches>]}
Use an empty list when none matches. Nothing is cancelled until the user confirms.

If the user says they already did a pending reminder or task ("ya compré las pilas"), reply:
{"kind":"reminder_done","ids":[<the "id" of each pending reminder or task that matches>]}
Use an empty list when none matches.

"reminders" holds "now" (the local date and time), "weekday" and "pending": the pending reminders and tasks, each with its "id", "text" and "when" (null for a task).`;

/** The pending reminders and tasks among `ids`, in S-44 order, once each (R-25 AC9, AC10). */
const pendingAmong = (env: CapabilityEnv, ids: readonly number[]): Reminder[] => {
  const picked = new Set(ids);
  return listPending(env.db).filter(({ id }) => picked.has(id));
};

const itemsOf = (reminders: readonly Reminder[], { now, timeZone }: CapabilityEnv) =>
  reminders.map((reminder) => ({ text: reminder.text, when: whenOf(reminder, now(), timeZone) }));

/** When a call is due, UTC: `null` for a task, `'passed'` for a one-time time already gone. */
const dueAtOf = (call: CreateCall, at: Date, timeZone: string): Date | null | 'passed' => {
  const recurrence = call.recurrence ?? null;
  if (recurrence !== null) return nextOccurrence(recurrence, at, timeZone);
  if (call.at == null) return null;
  const dueAt = utcOf(call.at.slice(0, 10), call.at.slice(11), timeZone);
  // R-25 AC4: a time that has already passed is not stored.
  return dueAt <= at ? 'passed' : dueAt;
};

/**
 * R-25 AC6, R-21: the reply comes from the stored row, worded in the same call when the wording
 * keeps the facts, otherwise S-40 or S-41 verbatim.
 */
const storedReply = (id: number, call: CreateCall, at: Date, env: CapabilityEnv): Reply => {
  const stored = readReminder(env.db, id);
  const when = whenOf(stored, at, env.timeZone);
  const request =
    when === null
      ? { reference: strings.taskAdded(stored.text), facts: [stored.text] }
      : { reference: strings.reminderSet(when, stored.text), facts: [stored.text, when] };
  return { text: checkedPhrasing(call.reply ?? null, request, env.logger) };
};

/**
 * R-25 AC5: a pending task given a time becomes a reminder, by the same rules as creating one.
 * Its text is the task's, so it needs no quote from the message.
 */
const scheduleExisting = (
  id: number,
  call: CreateCall,
  channelRef: string,
  env: CapabilityEnv,
): Reply => {
  const task = pendingAmong(env, [id]).find(({ due_at }) => due_at === null);
  if (task === undefined) {
    env.logger.warn('reminder id is not a pending task; nothing scheduled', { channelRef, id });
    return { text: strings.nothingPendingMatches() };
  }
  const at = env.now();
  const dueAt = dueAtOf(call, at, env.timeZone);
  if (dueAt === 'passed') return { text: strings.timePassed() };
  if (dueAt !== null) {
    const scheduled = scheduleTask(env.db, id, {
      dueAt: dueAt.toISOString(),
      recurrence: call.recurrence ?? null,
    });
    if (!scheduled) return { text: strings.nothingPendingMatches() };
  }
  return storedReply(id, call, at, env);
};

const create = (call: CreateCall, message: PrincipalText, env: CapabilityEnv): Reply => {
  // R-25 AC3: a repetition it cannot keep is not stored.
  if (call.unsupported_recurrence === true) return { text: strings.recurrenceUnsupported() };
  if (call.id != null) return scheduleExisting(call.id, call, message.channelRef, env);
  // R-25 AC2: the text must be the principal's own words; otherwise the call does not validate,
  // and nothing is stored (R-24 AC2, R-22 AC1).
  if (!quotedFrom(call.text, message.text)) {
    env.logger.error('reminder text not quoted from the message; not stored', {
      channelRef: message.channelRef,
    });
    return { text: strings.processingFailed() };
  }
  const at = env.now();
  const dueAt = dueAtOf(call, at, env.timeZone);
  if (dueAt === 'passed') return { text: strings.timePassed() };

  const id = createReminder(env.db, {
    text: call.text,
    dueAt: dueAt?.toISOString() ?? null,
    recurrence: call.recurrence ?? null,
    source: message.channelRef,
    receivedAt: message.receivedAt,
    now: at.toISOString(),
  });
  return storedReply(id, call, at, env);
};

/**
 * R-25 AC9: code asks S-46 before cancelling the picked pending items, or replies S-49. The
 * stored question is only the S-46 header, as for forgetting (R-23 AC6).
 */
const askToCancel = (ids: readonly number[], env: CapabilityEnv): Reply => {
  const matches = pendingAmong(env, ids);
  if (matches.length === 0) return { text: strings.nothingPendingMatches() };
  const options = [buttons.yes, buttons.no];
  const decisionId = openCancelReminderDecision(env.db, {
    reminderIds: matches.map(({ id }) => id),
    question: strings.confirmCancel([]),
    options,
    now: env.now().toISOString(),
  });
  return {
    text: strings.confirmCancel(itemsOf(matches, env)),
    buttons: decisionButtons(decisionId, options),
    onDelivered: (delivery) => {
      if (!recordDecisionMessage(env.db, decisionId, delivery.channelRef)) {
        env.logger.warn('decision message already recorded', { decisionId });
      }
    },
  };
};

/** R-25 AC10: the picked pending items are done at once, without buttons; S-50 or S-49. */
const markPickedDone = (ids: readonly number[], env: CapabilityEnv): Reply => {
  const matches = pendingAmong(env, ids);
  const done = new Set(
    markDone(
      env.db,
      matches.map(({ id }) => id),
      env.now().toISOString(),
    ),
  );
  const texts = matches.filter(({ id }) => done.has(id)).map(({ text }) => text);
  return { text: texts.length === 0 ? strings.nothingPendingMatches() : strings.markedDone(texts) };
};

export const remindersCapability = defineCapability({
  name: 'reminders',
  kinds: ['reminder_create', 'reminder_list', 'reminder_cancel', 'reminder_done'],
  prompt: PROMPT,
  schema: callSchema,
  // R-25 AC1: the time in TZ and what is pending, so relative times and references can be read.
  context: ({ db, now, timeZone }) => {
    const { date, time, weekday } = localParts(now(), timeZone);
    return {
      now: `${date}T${time}`,
      weekday,
      pending: listPending(db).map((reminder) => ({
        id: reminder.id,
        text: reminder.text,
        when: whenOf(reminder, now(), timeZone),
      })),
    };
  },
  handle: async (call, message, env) => {
    if (call.kind === 'reminder_create') return create(call, message, env);
    if (call.kind === 'reminder_cancel') return askToCancel(call.ids, env);
    if (call.kind === 'reminder_done') return markPickedDone(call.ids, env);
    // R-25 AC8: reminders soonest first, then tasks oldest first, listed by code.
    const pending = listPending(env.db);
    return {
      text:
        pending.length === 0 ? strings.nothingPending() : strings.pending(itemsOf(pending, env)),
    };
  },
});
