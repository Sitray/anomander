import { isCalendarDate } from '@anomander/core';
import { strings } from '@anomander/protocol';
import { z } from 'zod';
import { defineCapability } from '../capabilities/capability.ts';
import { checkedPhrasing } from '../processor/reply-phraser.ts';
import { quotedFrom } from '../store/memory.ts';
import { createReminder, listPending, readReminder, recurrenceSchema } from '../store/reminders.ts';
import { localParts, nextOccurrence, utcOf, whenOf } from './when.ts';

// R-25: reminders and tasks, the first capability (R-24 AC4). Creating one is the principal's own
// declaration, so it runs at once, without buttons (AC2). The text is never logged (AC12): log
// calls here carry the channel reference and reasons only.

const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

const createSchema = z.object({
  kind: z.literal('reminder_create'),
  text: z.string().trim().min(1),
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

const PROMPT = `If the user asks you to remind them of something ("recuérdame mañana llamar a mamá") or notes something they have to do, with or without a date ("tengo que comprar pilas"), reply:
{"kind":"reminder_create","text":"<what to remember, copied word for word from the message>","at":"<YYYY-MM-DDTHH:mm, the local time to remind them>","recurrence":null,"unsupported_recurrence":false,"reply":"<a short, friendly reply in Spanish (es-ES), at most 280 characters, saying the same as: Te lo recuerdo <cuando>: <text>.>"}
Work out "at" from the "now" and "weekday" fields of "reminders" ("mañana", "en dos horas", "el viernes"). A day without a time means 09:00.
If it repeats every day, every week on some days, or every month on one day, always at one time, set "at" to null and "recurrence" to {"freq":"daily","time":"HH:mm"}, {"freq":"weekly","days":[<1 Monday to 7 Sunday>],"time":"HH:mm"} or {"freq":"monthly","day":<1 to 31>,"time":"HH:mm"}.
If it repeats in any other way ("cada dos semanas", "el último viernes de cada mes"), set "unsupported_recurrence" to true.
If it has no date at all, set "at" and "recurrence" to null, and "reply" says the same as: Apuntado en tus pendientes: <text>.
Write <cuando> as "hoy a las 9:00", "mañana a las 9:00", "el 29 de octubre a las 9:00", "todos los días a las 9:00", "todos los lunes y jueves a las 8:00" or "el día 15 de cada mes a las 9:00", and "a la 1:00" at one o'clock. Copy <text> exactly and add no other number.
You never store the reminder: the assistant does, and sends "reply" only if it keeps the facts.
"reminders" holds "now" (the local date and time), "weekday" and "pending": the pending reminders and tasks, each with its "id", "text" and "when" (null for a task).`;

export const remindersCapability = defineCapability({
  name: 'reminders',
  kinds: ['reminder_create'],
  prompt: PROMPT,
  schema: createSchema,
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
  handle: async (call, message, { db, timeZone, now, logger }) => {
    // R-25 AC3: a repetition it cannot keep is not stored.
    if (call.unsupported_recurrence === true) return { text: strings.recurrenceUnsupported() };
    // R-25 AC2: the text must be the principal's own words; otherwise the call does not validate,
    // and nothing is stored (R-24 AC2, R-22 AC1).
    if (!quotedFrom(call.text, message.text)) {
      logger.error('reminder text not quoted from the message; not stored', {
        channelRef: message.channelRef,
      });
      return { text: strings.processingFailed() };
    }
    const at = now();
    const recurrence = call.recurrence ?? null;
    let dueAt: Date | null = null;
    if (recurrence !== null) {
      dueAt = nextOccurrence(recurrence, at, timeZone);
    } else if (call.at != null) {
      dueAt = utcOf(call.at.slice(0, 10), call.at.slice(11), timeZone);
      // R-25 AC4: a time that has already passed is not stored.
      if (dueAt <= at) return { text: strings.timePassed() };
    }

    const id = createReminder(db, {
      text: call.text,
      dueAt: dueAt?.toISOString() ?? null,
      recurrence,
      source: message.channelRef,
      receivedAt: message.receivedAt,
      now: at.toISOString(),
    });

    // R-25 AC6, R-21: the reply comes from the stored row, worded in the same call when the
    // wording keeps the facts, otherwise S-40 or S-41 verbatim.
    const stored = readReminder(db, id);
    const when = whenOf(stored, at, timeZone);
    const request =
      when === null
        ? { reference: strings.taskAdded(stored.text), facts: [stored.text] }
        : { reference: strings.reminderSet(when, stored.text), facts: [stored.text, when] };
    return { text: checkedPhrasing(call.reply ?? null, request, logger) };
  },
});
