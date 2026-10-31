import { remindersCapability } from '../reminders/capability.ts';
import type { Capability } from './capability.ts';

// R-24 AC1: the registered capabilities. Adding one here adds its kinds to the text interpreter's
// prompt and to the dispatch of the text handler; no routing code changes.
export const CAPABILITIES: readonly Capability[] = [remindersCapability];
