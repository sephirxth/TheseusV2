/**
 * Two doors (docs/design/intent.md 2.3).
 *
 * The whole "is it my intent" criterion rests on the actor's middle segment (human or not). This criterion needs
 * something backing it: if an agent can write a trace whose middle segment is `human`, the criterion is bypassed.
 *
 * The approach follows DeepSeek Harness: their model cannot reach the host entry, so it cannot fabricate a human utterance.
 * Our counterpart —
 *
 *   human door (transcription intercept / CLI / panel)   speaks only for the human: middle segment must be `human`
 *   agent door (the one MCP tools / CLI subcommands plug into)   cannot write: middle segment `human` is rejected on the spot
 *
 * Default direction is also set against the pit they hit (authority.ts:67-68 warning): a producer that does not declare
 * who it is **does not get** human privileges here — not because we are more careful, but because the mistake has nowhere to happen.
 *
 * ★5 must be said clearly: both doors live in one process. Code that can directly import `Trace` can still forge
 * a human utterance; what is blocked is the entry the agent can actually reach. DSH blocks only to this layer too.
 */
import { TraceRefused } from './trace.ts';
import type { Mark, Step, Trace } from './trace.ts';

/** The actor's middle segment: the segment of `namespace:type:session` deciding human-vs-agent. */
export const middleOf = (actor: string): string => actor.split(':')[1] ?? '';

export interface Door {
  record(m: Mark): Step;
}

/** The entry the agent can reach. */
export const agentDoor = (t: Trace): Door => ({
  record(m: Mark): Step {
    if (middleOf(m.actor) === 'human') {
      throw new TraceRefused(
        `'${m.type}': the agent door cannot write human utterances (middle segment of '${m.actor}' is human)`);
    }
    return t.record(m);
  },
});

/** The human door. Other producers must explicitly declare who they are; silent inheritance of human privileges is forbidden. */
export const humanDoor = (t: Trace): Door => ({
  record(m: Mark): Step {
    if (middleOf(m.actor) !== 'human') {
      throw new TraceRefused(
        `'${m.type}': the human door speaks only for the human (middle segment of '${m.actor}' is not human)`);
    }
    return t.record(m);
  },
});
