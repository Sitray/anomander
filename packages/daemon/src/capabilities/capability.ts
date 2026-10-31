import type { PrincipalText, Reply } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { z } from 'zod';
import type { Logger } from '../processor/text-interpreter.ts';

// R-24: what ANOMANDER can do grows by adding capabilities. A capability declares the kinds of
// request it handles, the instructions it adds to the text interpreter's prompt, the schema code
// validates the processor's call with, and the handler that carries the call out. The processor
// only returns the call (R-14); the handler decides and writes (AC3).

/** What a capability may use to build its prompt context and to carry out a call. */
export interface CapabilityEnv {
  db: Database.Database;
  /** `TZ`. */
  timeZone: string;
  now: () => Date;
  logger: Logger;
}

export interface CapabilitySpec<Call extends { kind: string }> {
  /** Also the field of the interpreter's user turn that holds `context`. */
  name: string;
  /** The envelope kinds the capability handles; no two capabilities share one. */
  kinds: readonly Call['kind'][];
  /** Instructions and JSON shape added to the text interpreter's prompt (R-24 AC1). */
  prompt: string;
  /** Validates the processor's call (R-24 AC2). */
  schema: z.ZodType<Call>;
  /** What the processor needs to read the message, sent under `name` in the user turn. */
  context?: (env: CapabilityEnv) => unknown;
  /** Carries out a validated call (R-24 AC3). */
  handle: (call: Call, message: PrincipalText, env: CapabilityEnv) => Promise<Reply>;
}

/** A call the processor returned and code validated, ready to be carried out. */
export interface CapabilityCall {
  capability: string;
  carryOut: (message: PrincipalText, env: CapabilityEnv) => Promise<Reply>;
}

/** A registered capability, whatever the type of its calls. */
export interface Capability {
  name: string;
  kinds: readonly string[];
  prompt: string;
  context?: (env: CapabilityEnv) => unknown;
  /** The validated call, or the first schema issue as `path code` (never the values). */
  accept: (envelope: unknown) => { call: CapabilityCall } | { issue: string };
}

export const defineCapability = <Call extends { kind: string }>(
  spec: CapabilitySpec<Call>,
): Capability => ({
  name: spec.name,
  kinds: spec.kinds,
  prompt: spec.prompt,
  ...(spec.context === undefined ? {} : { context: spec.context }),
  accept: (envelope) => {
    const parsed = spec.schema.safeParse(envelope);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { issue: issue ? `${issue.path.join('.') || '(root)'} ${issue.code}` : 'unknown' };
    }
    const call = parsed.data;
    return {
      call: { capability: spec.name, carryOut: (message, env) => spec.handle(call, message, env) },
    };
  },
});

/** The capability that handles `kind`, if any. */
export const capabilityFor = (
  capabilities: readonly Capability[],
  kind: unknown,
): Capability | undefined =>
  typeof kind === 'string' ? capabilities.find(({ kinds }) => kinds.includes(kind)) : undefined;

/** The user-turn fields the capabilities add, each under its capability's name (R-25 AC1). */
export const capabilityContext = (
  capabilities: readonly Capability[],
  env: CapabilityEnv,
): Record<string, unknown> =>
  Object.fromEntries(
    capabilities.flatMap(({ name, context }) =>
      context === undefined ? [] : [[name, context(env)]],
    ),
  );
