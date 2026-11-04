import { buttons, decisionButtons, type Reply, strings } from '@anomander/protocol';
import { z } from 'zod';
import { type CapabilityEnv, defineCapability } from '../capabilities/capability.ts';
import { activePermissions, openGrantDecision, revokePermissions } from '../store/permissions.ts';
import { recordDecisionMessage } from '../store/receipts.ts';
import { WEEKLY_SUMMARY_OPERATION } from './weekly-summary.ts';

// R-10 AC5-AC8: turning the weekly summary on and off, the third capability (R-24). It is off by
// default and exists only when the principal asks for it; nothing here offers it. Code asks
// S-74, and only the principal's "Sí" grants the permission (§8.1). Turning it off revokes at
// once, without buttons. It is sent at `ANOMANDER_WEEKLY_SUMMARY_CRON`; the permission holds no
// time.

const callSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('weekly_summary_enable') }),
  z.object({ kind: z.literal('weekly_summary_disable') }),
]);

// AC8: "el resumen" alone stays the morning digest (R-26).
const PROMPT = `If the user asks you to send them the weekly summary of their expenses ("mándame el resumen semanal", "quiero el resumen de gastos de la semana"), reply:
{"kind":"weekly_summary_enable"}
You never turn it on: the assistant asks the user first.

If the user asks you to stop sending the weekly summary ("deja de mandarme el resumen semanal"), reply:
{"kind":"weekly_summary_disable"}

Use these two only when the user says the summary is weekly or of the week; a summary with no such word is the morning summary. Never offer the weekly summary yourself.`;

/** AC6: asks S-74, or replies S-76 when the summary is already on. S-74 carries no private data. */
const askToEnable = (env: CapabilityEnv): Reply => {
  const at = env.now();
  if (activePermissions(env.db, WEEKLY_SUMMARY_OPERATION, at).length > 0) {
    return { text: strings.weeklySummaryAlreadyOn() };
  }
  const options = [buttons.yes, buttons.no];
  const question = strings.confirmWeeklySummary();
  const decisionId = openGrantDecision(env.db, {
    operation: 'grant_weekly_summary',
    payload: {},
    rule: 'R-10 AC6',
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

export const weeklySummaryCapability = defineCapability({
  name: 'weekly-summary',
  kinds: ['weekly_summary_enable', 'weekly_summary_disable'],
  prompt: PROMPT,
  schema: callSchema,
  handle: async (call, _message, env) => {
    if (call.kind === 'weekly_summary_enable') return askToEnable(env);
    // AC7: revoked at once; S-78 when none was in force.
    const revoked = revokePermissions(env.db, WEEKLY_SUMMARY_OPERATION, env.now().toISOString());
    return { text: revoked === 0 ? strings.weeklySummaryWasOff() : strings.weeklySummaryOff() };
  },
});
