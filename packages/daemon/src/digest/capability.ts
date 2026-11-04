import { buttons, decisionButtons, type Reply, strings } from '@anomander/protocol';
import { z } from 'zod';
import { type CapabilityEnv, defineCapability } from '../capabilities/capability.ts';
import {
  activeDigestPermission,
  openDigestDecision,
  revokeDigestPermissions,
} from '../store/digest.ts';
import { recordDecisionMessage } from '../store/receipts.ts';

// R-26: the morning digest, the second capability (R-24). It is off by default and exists only
// when the principal asks for it; nothing here offers it. The processor only returns the time
// (AC1); code asks S-53, and only the principal's "Sí" grants the permission (AC2, §8.1).
// Turning it off revokes at once, without buttons (AC4).

/** Without a time, the digest is asked for at 8:00 (AC1). */
const DEFAULT_TIME = '08:00';

/** `HH:mm`; `H:mm` from the processor is read the same and kept as `HH:mm` (R-24 AC2). */
const time = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
  .transform((value) => value.padStart(5, '0'));

const enableSchema = z.object({
  kind: z.literal('digest_enable'),
  time: time.nullable().optional(),
});
const disableSchema = z.object({ kind: z.literal('digest_disable') });

const callSchema = z.discriminatedUnion('kind', [enableSchema, disableSchema]);

const PROMPT = `If the user asks you to send them a summary every morning ("mándame un resumen cada mañana a las 7:30"), or to send it at another time ("pásame el resumen a las 9"), reply:
{"kind":"digest_enable","time":"<HH:mm, the local time they asked for, or null when they gave none>"}
You never turn it on: the assistant asks the user first.

If the user asks you to stop sending the morning summary ("deja de mandarme el resumen"), reply:
{"kind":"digest_disable"}

Never offer the morning summary yourself.`;

/**
 * R-26 AC1, AC3: asks S-53 for the time, or replies S-59 when it is the time already in force.
 * The stored question is S-53 itself: it carries no private data.
 */
const askToEnable = (askedTime: string, env: CapabilityEnv): Reply => {
  const at = env.now();
  if (activeDigestPermission(env.db, at)?.time === askedTime) {
    return { text: strings.digestAlreadyOn(askedTime) };
  }
  const options = [buttons.yes, buttons.no];
  const question = strings.confirmDigest(askedTime);
  const decisionId = openDigestDecision(env.db, {
    time: askedTime,
    question,
    options,
    now: at.toISOString(),
  });
  return {
    text: question,
    buttons: decisionButtons(decisionId, options),
    onDelivered: (delivery) => {
      if (!recordDecisionMessage(env.db, decisionId, delivery.channelRef)) {
        env.logger.warn('decision message already recorded', { decisionId });
      }
    },
  };
};

export const digestCapability = defineCapability({
  name: 'digest',
  kinds: ['digest_enable', 'digest_disable'],
  prompt: PROMPT,
  schema: callSchema,
  handle: async (call, _message, env) => {
    if (call.kind === 'digest_enable') return askToEnable(call.time ?? DEFAULT_TIME, env);
    // R-26 AC4: revoked at once; S-58 when none was in force.
    const revoked = revokeDigestPermissions(env.db, env.now().toISOString());
    return { text: revoked === 0 ? strings.digestWasOff() : strings.digestOff() };
  },
});
