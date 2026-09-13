/**
 * Intent tree (docs/design/intent.md).
 *
 * **The intent tree is not a new table; it is a fold over the trace table.**
 *
 *  - Only the traces I accepted grow into nodes; agent proposals (`intent.proposed`) grow none.
 *  - A node's parent **is the one I was pursuing at the moment of its birth** — not a field that can be mis-filled,
 *    but computed in time order during the fold (★A).
 *  - Merging, revision, dropping — all are later-appended traces; **not one rewrites history**.
 *
 * The tree has no storage of its own. Nothing in this file "writes the tree back" — to make what the tree says diverge from
 * what actually happened, the only way is to make something happen — and happening leaves traces (U15-5).
 *
 * Criteria (section 2, all three required, missing one disqualifies): a tree-mutating trace counts if and only if
 *   (1) its prior step **directly points to** a trace H (indirection = using last week's words as today's authorization; no);
 *   (2) H's actor middle segment is `human`;
 *   (3) H came through the human door — this one is given by structure: the agent door cannot write human (doors.ts).
 * Criteria live at the doors (early rejection at write time), but **what counts is the fold query**: what is forced past the door, the fold still refuses.
 *
 * "Current" belongs to me, not to a session (1.5, ★1). One at a time; switching away is an action and leaves a trace
 * — which is exactly why U17's "returning relies on no one remembering" holds.
 *
 * The fold's shape follows DeepSeek Harness's `applyGoalProjection`: an event comes in; recognized, it folds;
 * unrecognized, it returns verbatim. **What is complex is the criterion, not the code.**
 */
import { middleOf, agentDoor } from './doors.ts';
import type { Door } from './doors.ts';
import type { Origin, Step, Trace } from './trace.ts';

/** This door refused. The reason must be stateable — a door that only refuses without saying why is just a wall. */
export class IntentRefused extends Error {
  override readonly name = 'IntentRefused';
}

/**
 * Three marks (3.3, ★D): marks for the machine, colors for the eye — two needs, satisfied separately.
 * Line-start, plain text — one regex fishes them out of any pile of dialogue. The marks are useful
 * because they ride the already-running pipe of "conversations are auto-intercepted".
 * ★2: these three strings are ours; whether they collide with existing text has not been tested against old dialogue.
 */
export const MARK_ADOPTED = '[intent·accepted]';
export const MARK_GUESSED = '[intent·guess]';
export const MARK_CORRECTED = '[intent·corrected]';

export const guessedLine = (text: string): string => `${MARK_GUESSED} ${text}`;
export const correctedLine = (text: string): string => `${MARK_CORRECTED} ${text}`;

/**
 * A node is that `intent.adopted` trace itself, identified by its trace number (1.3, the git-commit approach:
 * no second numbering scheme means one fewer place to disagree).
 */
export interface IntentNode {
  readonly id: string;
  /** The current saying. Revision replaces this; the old saying stays in the original trace, untouched. */
  readonly saying: string;
  /** Birth edge: the current at the moment of birth. Never changes — merging does not touch it (★B). */
  readonly parent: string | null;
  /** Exactly three (4.4, following DSH's Agent Note lifecycle): **there is no "quietly vanished" state.** */
  readonly status: 'open' | 'done' | 'dropped';
  /** Merge: not a birth edge, symmetric on both sides (section 5, ★B). Display carries "merged with X". */
  readonly mergedWith: readonly string[];
  /** Most recent activity (used for 7.3 ordering; **ordering never changes any record's fate**). */
  readonly lastTouched: string;
}

export interface IntentTree {
  readonly current: string | null;
  readonly nodes: ReadonlyMap<string, IntentNode>;
}

export interface Propose {
  readonly text: string;
  /** Prior step or origin, mutually exclusive — same rule as traces themselves. */
  readonly cause?: string;
  readonly origin?: Origin;
  /** On what basis this guess (optional). */
  readonly about?: readonly string[];
  /** Idempotency key (optional): the same proposal re-submitted is not recorded twice. Same rule as traces. */
  readonly idem?: string;
  /** When the thing the proposal refers to happened/was registered (optional, ISO date). The proposal's own moment is always the trace's ts. */
  readonly at?: string;
}
export interface Adopt {
  /** The trace number of the human's utterance. What counts is it, not the agent writing the trace. */
  readonly said: string;
  readonly text: string;
  /** Which proposal this accepts (optional) — once accepted, that proposal counts as answered. */
  readonly accepting?: string;
}
export interface Resume { readonly said: string; readonly node: string }
export interface Correct { readonly said: string; readonly target: string; readonly text: string }
export interface Drop { readonly said: string; readonly target: string; readonly why: string }
export interface Done { readonly said: string; readonly target: string }
export interface Merge { readonly said: string; readonly a: string; readonly b: string; readonly why?: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Node {
  id: string;
  saying: string;
  parent: string | null;
  status: 'open' | 'done' | 'dropped';
  mergedWith: string[];
  lastTouched: string;
}

export class Intent {
  readonly #trace: Trace;
  readonly #door: Door;
  readonly #actor: string;

  /**
   * `actor` is the three-segment identity of the agent writing the trace. Writes go through the agent door: intent traces are
   * recorded by the agent on my behalf; it **may not** write under a human name (synthetic provenance is fixed —
   * structurally impossible to mistake for a human's words — the DSH goal-round-driver approach).
   */
  constructor(trace: Trace, actor: string) {
    this.#trace = trace;
    this.#door = agentDoor(trace);
    this.#actor = actor;
  }

  // ───────────────────────────── writes: seven trace kinds ─────────────────────────────

  /** "I guess you want X". Write freely; none grow into nodes — the tree holds only what I accepted. */
  propose(o: Propose): Step {
    if (o.text.trim() === '') throw new IntentRefused(`intent.proposed: an empty guess cannot be proposed`);
    return this.#door.record({
      actor: this.#actor, type: 'intent.proposed',
      ...(o.cause !== undefined ? { cause: o.cause } : {}),
      ...(o.origin !== undefined ? { origin: o.origin } : {}),
      ...(o.about !== undefined && o.about.length > 0 ? { basis: o.about } : {}),
      ...(o.idem !== undefined ? { idem: o.idem } : {}),
      payload: { text: o.text, ...(o.at !== undefined ? { at: o.at } : {}) },
    });
  }

  /** Grow a node: parent = the current at this moment; current moves to the new node. */
  adopt(o: Adopt): Step {
    const h = this.#saidBy(o.said, 'intent.adopted');
    if (o.text.trim() === '') {
      throw new IntentRefused(`intent.adopted: a node is an utterance — an empty saying cannot grow into a node`);
    }
    if (o.accepting !== undefined) this.#mustBe(o.accepting, ['intent.proposed'], 'the accepted');
    return this.#door.record({
      actor: this.#actor, type: 'intent.adopted', cause: h.id,
      ...(o.accepting !== undefined ? { basis: [o.accepting] } : {}),
      payload: { text: o.text },
    });
  }

  /** Move the current back to an existing node. "Going back" itself leaves a trace — U17 relies on this, not on anyone's memory. */
  resume(o: Resume): Step {
    const h = this.#saidBy(o.said, 'intent.resumed');
    this.#mustBe(o.node, ['intent.adopted'], 'the returned-to');
    return this.#door.record({
      actor: this.#actor, type: 'intent.resumed', cause: h.id, basis: [o.node], payload: {},
    });
  }

  /**
   * Replace a node's (or proposal's) current saying. The old saying stays in place, untouched —
   * so "what it guessed wrong and what I corrected it to" remain naturally paired (the raw material of U19 (3)).
   */
  correct(o: Correct): Step {
    const h = this.#saidBy(o.said, 'intent.corrected');
    if (o.text.trim() === '') throw new IntentRefused(`intent.corrected: correcting into an empty phrase is no correction`);
    this.#mustBe(o.target, ['intent.adopted', 'intent.proposed'], 'the corrected');
    return this.#door.record({
      actor: this.#actor, type: 'intent.corrected', cause: h.id, basis: [o.target],
      payload: { text: o.text },
    });
  }

  /**
   * "I'm dropping this" / "I don't want this" (which one is visible from whether the target is a node or a proposal).
   * **A why is mandatory**: the drop reason is the only basis for whether-to-pick-back-up (DSH's rule
   * for rejecting notes — kept only while the reason still blocks a tempting mistake).
   */
  drop(o: Drop): Step {
    const h = this.#saidBy(o.said, 'intent.dropped');
    if (o.why.trim() === '') {
      throw new IntentRefused(`intent.dropped: no why given. The drop reason is the only basis for whether-to-pick-back-up`);
    }
    this.#mustBe(o.target, ['intent.adopted', 'intent.proposed'], 'the unwanted');
    return this.#door.record({
      actor: this.#actor, type: 'intent.dropped', cause: h.id, basis: [o.target],
      payload: { why: o.why },
    });
  }

  /** "Done". Agents have no such opening (2.4): a task being finished is not my intent being fulfilled. */
  done(o: Done): Step {
    const h = this.#saidBy(o.said, 'intent.done');
    this.#mustBe(o.target, ['intent.adopted'], 'the finished');
    return this.#door.record({
      actor: this.#actor, type: 'intent.done', cause: h.id, basis: [o.target], payload: {},
    });
  }

  /** Merge: adds a non-birth edge; both birth edges untouched (section 5, ★B). Current does not move. */
  merge(o: Merge): Step {
    const h = this.#saidBy(o.said, 'intent.merged');
    if (o.a === o.b) throw new IntentRefused(`intent.merged: a node merged with itself produces nothing`);
    this.#mustBe(o.a, ['intent.adopted'], 'the merged');
    this.#mustBe(o.b, ['intent.adopted'], 'the merged');
    return this.#door.record({
      actor: this.#actor, type: 'intent.merged', cause: h.id, basis: [o.a, o.b],
      payload: o.why !== undefined ? { why: o.why } : {},
    });
  }

  // ───────────────────────────── reads: folding & views ─────────────────────────────

  /**
   * The fold (1.2). State is exactly two things: which node is current, and what each node currently looks like.
   * One switch, six branches, each changing one piece of state — the complexity lives in the doors, not here.
   *
   * Criteria are re-checked on every row: **doors are convention, the query is structure.** What was forced past the door is not counted here.
   */
  tree(): IntentTree {
    const nodes = new Map<string, Node>();
    let current: string | null = null;
    for (const s of this.#trace.ofType('intent.')) {
      if (s.type === 'intent.proposed') continue;            // proposals do not enter the fold: the tree holds only what I accepted
      if (s.cause === null) continue;                        // criterion (1): must hang directly on an utterance
      const h = this.#trace.get(s.cause);
      if (h === null) continue;
      if (middleOf(h.actor) !== 'human') continue;           // criterion (2) ((3) is structurally guaranteed by doors.ts)
      const t0 = s.basis[0];
      switch (s.type) {
        case 'intent.adopted': {
          const text = str(s.payload['text']);
          if (text === '') continue;
          nodes.set(s.id, {
            id: s.id, saying: text, parent: current, status: 'open',
            mergedWith: [], lastTouched: s.ts,
          });
          current = s.id;
          break;
        }
        case 'intent.resumed': {
          const n = t0 === undefined ? undefined : nodes.get(t0);
          if (n === undefined) continue;
          current = n.id;
          n.lastTouched = s.ts;
          break;
        }
        case 'intent.corrected': {
          const n = t0 === undefined ? undefined : nodes.get(t0);
          if (n === undefined) continue;                     // the corrected is a proposal: tree untouched, the pair stays in traces
          const text = str(s.payload['text']);
          if (text === '') continue;
          n.saying = text;
          n.lastTouched = s.ts;
          break;
        }
        case 'intent.dropped': {
          const n = t0 === undefined ? undefined : nodes.get(t0);
          if (n === undefined) continue;                     // the unwanted is a proposal: it was never on the tree
          n.status = 'dropped';
          n.lastTouched = s.ts;
          break;
        }
        case 'intent.done': {
          const n = t0 === undefined ? undefined : nodes.get(t0);
          if (n === undefined) continue;
          n.status = 'done';
          n.lastTouched = s.ts;
          break;
        }
        case 'intent.merged': {
          const a = t0 === undefined ? undefined : nodes.get(t0);
          const t1 = s.basis[1];
          const b = t1 === undefined ? undefined : nodes.get(t1);
          if (a === undefined || b === undefined || a === b) continue;
          a.mergedWith.push(b.id);
          b.mergedWith.push(a.id);
          a.lastTouched = s.ts;
          b.lastTouched = s.ts;
          break;
        }
        default:
          continue;                                          // unrecognized intent.*: return verbatim, no folding
      }
    }
    return { current, nodes };
  }

  /** U15: walk from current to root along birth edges. Roots sort first — "why it began" is right there at position one. */
  path(): readonly IntentNode[] {
    const { current, nodes } = this.tree();
    const out: IntentNode[] = [];
    for (let id = current; id !== null; ) {
      const n = nodes.get(id);
      if (n === undefined) break;
      out.unshift(n);
      id = n.parent;
    }
    return out;
  }

  /** U15's sentence. No need for me to compose it — it sits there, queried, needing no one to remember to write it, impossible to write wrong. */
  line(): string {
    const p = this.path();
    if (p.length === 0) return `${MARK_ADOPTED} (empty — no intent accepted yet)`;
    return `${MARK_ADOPTED} ${p.map((n) => n.saying).join(' > ')}`;
  }

  /**
   * U16: dangling branches. One criterion only (7.1): neither done nor dropped.
   * Deliberately ignores staleness, depth, list length; **no nudge to wrap up ever appears, however long it runs** (7.2).
   * Sorted by recent activity (7.3) — recently-touched is easier to resume, nothing more.
   */
  dangling(): readonly IntentNode[] {
    return [...this.tree().nodes.values()]
      .filter((n) => n.status === 'open')
      .sort((x, y) =>
        x.lastTouched === y.lastTouched
          ? (x.id < y.id ? 1 : -1)
          : (x.lastTouched < y.lastTouched ? 1 : -1));
  }

  /**
   * U19 (4): the agent proposed, I spoke, and that utterance did not answer it. **This is not a hole in the tree; it is a signal about the
   * agent.** "Answered" is just the forward-walking query (became) — zero new lines of code;
   * "whose turn" is bounded by my next utterance (3.2, ★C) — no timer; timers wrong people.
   */
  unanswered(): readonly Step[] {
    return this.#trace.ofType('intent.proposed')
      .filter((p) => this.#trace.became(p.id).length === 0)
      .filter((p) => this.#trace.humanSpokeAfter(p.id));
  }

  /**
   * U19 (3): corrections are retrievable, **and paired** — what it guessed wrong (the basis-pointed row, verbatim
   * in place) and what I corrected it to (this row). No second copy needed: append-only never modifies; pairs persist naturally.
   */
  corrections(): readonly { readonly guessed: Step; readonly corrected: Step }[] {
    const out: { guessed: Step; corrected: Step }[] = [];
    for (const s of this.#trace.ofType('intent.corrected')) {
      if (s.cause === null) continue;
      const h = this.#trace.get(s.cause);
      if (h === null || middleOf(h.actor) !== 'human') continue;
      const t0 = s.basis[0];
      const guessed = t0 === undefined ? null : this.#trace.get(t0);
      if (guessed === null) continue;
      out.push({ guessed, corrected: s });
    }
    return out;
  }

  /**
   * The opening put before the human (6.2: same pipe, one more thing delivered): the accepted path, one line,
   * and each guess not yet answered, one line each. **The unanswered is not here** (U19-5) — it is a signal for the agent,
   * is not my homework; and no wrap-up nagging ever appears (U16-4).
   */
  briefing(): string {
    const lines = [this.line()];
    for (const p of this.#trace.ofType('intent.proposed')) {
      if (this.#trace.became(p.id).length > 0) continue;     // answered: page turned
      if (this.#trace.humanSpokeAfter(p.id)) continue;       // never accepted: a signal, not homework (U19-5)
      lines.push(guessedLine(str(p.payload['text'])));
    }
    return lines.join('\n');
  }

  // ─────────────────────────────── criteria at the doors ───────────────────────────────

  /** Criteria (1)(2): the mutation must hang on something I said — the utterance sits there; one look tells whether it is. */
  #saidBy(id: string, forWhat: string): Step {
    const h = this.#trace.get(id);
    if (h === null) {
      throw new IntentRefused(`${forWhat}: claims to hang on ${id}, which is not in the traces`);
    }
    if (middleOf(h.actor) !== 'human') {
      throw new IntentRefused(
        `${forWhat}: ${id} is not human speech (middle segment of actor '${h.actor}' is not human)`
        + ` — agent-proposed things do not become nodes automatically; only my acceptance makes them so`);
    }
    return h;
  }

  #mustBe(id: string, kinds: readonly string[], what: string): Step {
    const s = this.#trace.get(id);
    if (s === null) throw new IntentRefused(`${what}: row (${id}) not in the traces`);
    if (!kinds.includes(s.type)) {
      throw new IntentRefused(`${what}: row (${id}) is '${s.type}', not ${kinds.join(' / ')}`);
    }
    return s;
  }
}
