/**
 * Traces: what is left behind. **Recording** writes it; **tracing** reads it.
 *
 * The foundation is SQLite (docs/design/trace.md 0.5). Uses Node 22's built-in `node:sqlite` —
 * zero external dependencies, one library file, no service, no daemon, no port.
 *
 * This file is **the only door**: all writes come through `record`; touching the store directly is forbidden
 * (inherited from old Theseus's memory contract — the one thing it did most right).
 *
 * Four hard constraints of "traces must not be lost, must not be duplicated" — all off-the-shelf, zero lines of own logic:
 *   crash mid-write -> one transaction per row (a single INSERT is a transaction; ARIES write-ahead log, SQLite built-in)
 *   the same thing recorded twice -> `idem` unique constraint (Stripe's idempotency key)
 *   reader sees a half-written row -> WAL
 *   multiple writers -> SQLite queues them itself
 *
 * One more comes free: `CHECK (cause IS NULL OR cause < id)`. ULIDs sort by time, so this is
 * a pure string comparison, **yet makes causal cycles structurally impossible** — a cycle would mean a record is its own ancestor,
 * which requires it to be earlier than itself. It replaces an entire cycle-detection module that would otherwise be written.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { isRoutine } from './routine.ts';

/** The three origins I recognize. Walking back must end in one of them; stopping on something a human does not recognize is forbidden. */
export type Origin = 'you-said' | 'clock-fired' | 'arrived-from-outside';

/** One entry handed to this door. `cause` and `origin` are mutually exclusive: either there is a prior step, or this is an origin. */
export interface Mark {
  /** who did it: namespace:type:session */
  readonly actor: string;
  readonly type: string;
  /** Which trace is the prior step. */
  readonly cause?: string;
  /** With no prior step, which kind of origin this is must be stated. */
  readonly origin?: Origin;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** On what basis this was decided / judged. Required for decisions and self-summaries. */
  readonly basis?: readonly string[];
  /** Idempotency key; records without one do not participate in dedup. */
  readonly idem?: string;
}

export interface Step {
  readonly id: string;
  readonly ts: string;
  readonly actor: string;
  readonly type: string;
  readonly cause: string | null;
  readonly origin: Origin | null;
  readonly routine: boolean;
  readonly basis: readonly string[];
  readonly payload: Record<string, unknown>;
}

/**
 * Where the chain ends. **These must be told apart precisely** — a chain that is technically complete but does not answer
 * the question looks exactly like a good chain; broken, you know you don't know; fabricated, you think you know.
 */
export type ChainEnd =
  /** Ends at an origin I recognize. */
  | { readonly kind: 'origin'; readonly at: string; readonly origin: Origin }
  /** Ends at a record with no prior step and no stated origin. This door cannot write it; it can only have been shoved in from outside. */
  | { readonly kind: 'unrecognized'; readonly at: string; readonly type: string }
  /** The trace it points to is missing. **Broken here**; guessing one to attach is forbidden. */
  | { readonly kind: 'broken'; readonly at: string; readonly missing: string }
  /** Depth cap exceeded before reaching an end. **I did not finish walking — it is not that I reached the end.** */
  | { readonly kind: 'too-deep'; readonly at: string }
  /** The trace being asked about does not exist at all. */
  | { readonly kind: 'no-such-step'; readonly at: string };

export interface Chain {
  /** [the asked trace, its prior step, ...]. */
  readonly steps: readonly Step[];
  readonly end: ChainEnd;
}

export interface TraceOptions {
  /** The time (epoch ms). Only tests and backfill provide it. */
  readonly now?: () => number;
}

/** This door refused. **The reason must be stateable** — a door that only refuses without saying why is just a wall. */
export class TraceRefused extends Error {
  override readonly name = 'TraceRefused';
}

/** Second line of defense: guards against data shoved in from elsewhere. The first line is the CHECK. */
const DEPTH = 64;

const COLS = 'id, ts, actor, type, cause, routine, payload';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trace (
  id       TEXT PRIMARY KEY,
  ts       TEXT NOT NULL,
  actor    TEXT NOT NULL,
  type     TEXT NOT NULL,
  cause    TEXT REFERENCES trace(id),
  routine  INTEGER NOT NULL DEFAULT 0,
  payload  TEXT NOT NULL,
  idem     TEXT UNIQUE,

  CHECK (cause IS NULL OR cause < id),

  -- three segments, each non-empty. The door in record() above produces human-readable errors;
  -- this one is for whoever bypasses the door and writes the store directly: the door is convention, the constraint is structure.
  -- '_%' requires at least one character per segment; the second half rejects four or more segments.
  CHECK (actor LIKE '_%:_%:_%' AND actor NOT LIKE '%:%:%:%')
);
CREATE INDEX IF NOT EXISTS trace_cause  ON trace(cause);
CREATE INDEX IF NOT EXISTS trace_ts     ON trace(ts);
CREATE INDEX IF NOT EXISTS trace_type   ON trace(type);
CREATE INDEX IF NOT EXISTS trace_actor  ON trace(actor);
CREATE INDEX IF NOT EXISTS trace_recent ON trace(routine, id DESC);
`;

/** Ask backwards "why did this happen". One recursive query walks the whole chain, on the primary key. */
const BACK = `
WITH RECURSIVE chain(id, ts, actor, type, cause, routine, payload, depth) AS (
  SELECT ${COLS}, 0 FROM trace WHERE id = ?
  UNION ALL
  SELECT t.id, t.ts, t.actor, t.type, t.cause, t.routine, t.payload, chain.depth + 1
    FROM trace t JOIN chain ON t.id = chain.cause
   WHERE chain.depth < ${DEPTH}
)
SELECT * FROM chain`;

/**
 * Ask forwards "what became of this request". Two edge kinds: **whose prior step it is**, and **who cites it as basis**.
 *
 * Walking only the first is insufficient: when two requests merge into one, the merged-away one is nobody's prior step —
 * which is exactly where numpy 2.2.0 once vanished without a sound.
 */
const FORWARD = `
WITH RECURSIVE fwd(id, depth) AS (
  SELECT ?, 0
  UNION
  SELECT t.id, fwd.depth + 1
    FROM trace t, fwd
   WHERE fwd.depth < ${DEPTH}
     AND (t.cause = fwd.id
          OR EXISTS (SELECT 1 FROM json_each(t.payload, '$.basis') j WHERE j.value = fwd.id))
)
SELECT ${COLS} FROM trace WHERE id IN (SELECT id FROM fwd) AND id <> ? ORDER BY id`;

interface Row {
  id: string; ts: string; actor: string; type: string;
  cause: string | null; routine: number; payload: string; depth?: number;
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RAND_MAX = 1n << 80n;

const encodeTime = (ms: number): string => {
  let n = ms;
  let out = '';
  for (let i = 0; i < 10; i++) { out = B32[n % 32] + out; n = Math.floor(n / 32); }
  return out;
};

const encodeRand = (r: bigint): string => {
  let n = r;
  let out = '';
  for (let i = 0; i < 16; i++) { out = B32[Number(n & 31n)] + out; n >>= 5n; }
  return out;
};

const rand80 = (): bigint => {
  let n = 0n;
  for (const b of randomBytes(10)) n = (n << 8n) | BigInt(b);
  return n;
};

/** The decision itself must stay, along with the basis it was decided on at the time. */
const isDecision = (type: string): boolean => type.startsWith('decision.');

/** The system's words about itself: reflections / self-assessment / improvement conclusions. */
const isConclusion = (type: string): boolean => type.startsWith('self.');

export class Trace {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #stmts = new Map<string, StatementSync>();
  #lastMs = -1;
  #lastRand = 0n;

  constructor(file: string, o: TraceOptions = {}) {
    this.#now = o.now ?? Date.now;
    mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL');       // readers always see a complete state
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA foreign_keys = ON');        // what `cause` points to must exist, undeletable
    this.#db.exec('PRAGMA busy_timeout = 5000');      // multiple writers: queue, not error
    this.#db.exec(SCHEMA);
  }

  /**
   * The only door.
   *
   * Every refusal says the same thing: **do not let in a trace that cannot be walked later.**
   * Without a prior step and no stated origin, the chain stops on something a human does not recognize;
   * with a nonexistent prior step, the chain is broken from birth; a decision without basis yields only "it did not do it".
   */
  record(m: Mark): Step {
    // who did it: three segments — namespace:identity:session.
    // the middle segment is the sole basis of human-vs-agent — the intent tree's whole criterion rests on it
    // ("the prior step's middle segment must be human to count as my intent"). If it were a free string,
    // that criterion would be guessing.
    //
    // Pinned here rather than only in docs because this table is append-only: adding constraints after real data exists
    // would require rebuilding the table, and "traces are never rewritten" is the foundation of the whole thing.
    const seg = m.actor.split(':');
    if (seg.length !== 3 || seg.some((s) => s === '')) {
      throw new TraceRefused(`'${m.type}': who-did-it was written as '${m.actor}' —`
        + ` must be three segments namespace:identity:session (e.g. user:human:cli / agent:codex:sess-a1),`
        + ` none empty. The middle segment decides whether this trace counts as human speech.`);
    }

    const hasCause = m.cause !== undefined;
    const hasOrigin = m.origin !== undefined;
    if (hasCause && hasOrigin) {
      throw new TraceRefused(`'${m.type}': both prior step and origin given — a trace can only be one of them`);
    }
    if (!hasCause && !hasOrigin) {
      throw new TraceRefused(`'${m.type}': neither a prior step, nor a stated origin`
        + `(I recognize exactly three origins: you-said / clock-fired / arrived-from-outside)`);
    }
    if (m.cause !== undefined && this.get(m.cause) === null) {
      throw new TraceRefused(`'${m.type}': prior step ${m.cause} not in the traces`);
    }

    const basis = m.basis ?? [];
    const grounds = basis.map((id) => {
      const s = this.get(id);
      if (s === null) throw new TraceRefused(`'${m.type}': basis ${id} not in the traces`);
      return s;
    });
    if ((isDecision(m.type) || isConclusion(m.type)) && grounds.length === 0) {
      throw new TraceRefused(`'${m.type}': no basis — decisions and self-summaries must record what they were decided on`);
    }
    // U10-4. A rule that only checks form gets satisfied by form: the 2026-06-10 import stamped 2300 documents
    // each with an "I belong to batch N" anchor — the rule satisfied, meaninglessly. Routine is mechanical action,
    // no semantics: it may be background, **never the entire basis of a conclusion**.
    if (isConclusion(m.type) && !grounds.some((g) => !g.routine)) {
      throw new TraceRefused(`'${m.type}': basis is all routine (${grounds.map((g) => g.type).join(', ')})`
        + ` — that says which batch this belongs to, not where this conclusion comes from`);
    }

    if (m.idem !== undefined) {
      const hit = this.#byIdem(m.idem);
      if (hit !== null) return hit;                  // same event: return the original row, no error
    }

    const { id, ts } = this.#mint();
    const payload = JSON.stringify({
      ...(m.origin !== undefined ? { origin: m.origin } : {}),
      ...(basis.length > 0 ? { basis } : {}),
      body: m.payload ?? {},
    });
    try {
      // A single INSERT is itself a transaction: either the whole row lands, or it never happened.
      this.#db.prepare(`INSERT INTO trace(${COLS}, idem) VALUES(?,?,?,?,?,?,?,?)`).run(
        id, ts, m.actor, m.type, m.cause ?? null, isRoutine(m.type) ? 1 : 0, payload, m.idem ?? null,
      );
    } catch (e) {
      // Another writer used the same idempotency key first: same event — return theirs.
      if (m.idem !== undefined) {
        const hit = this.#byIdem(m.idem);
        if (hit !== null) return hit;
      }
      throw new TraceRefused(`'${m.type}': ${(e as Error).message}`);
    }
    const written = this.get(id);
    if (written === null) throw new TraceRefused(`'${m.type}': written but unreadable (${id})`);
    return written;
  }

  get(id: string): Step | null {
    const row = this.#db.prepare(`SELECT ${COLS} FROM trace WHERE id = ?`).get(id) as Row | undefined;
    return row === undefined ? null : toStep(row);
  }

  /** U7: ask backwards "why did it happen". */
  why(id: string): Chain {
    const rows = this.#db.prepare(BACK).all(id) as unknown as Row[];
    if (rows.length === 0) return { steps: [], end: { kind: 'no-such-step', at: id } };
    const steps = rows.map(toStep);
    const tail = steps[steps.length - 1] as Step;
    const depth = rows[rows.length - 1]?.depth ?? 0;
    if (tail.cause === null) {
      return {
        steps,
        end: tail.origin !== null
          ? { kind: 'origin', at: tail.id, origin: tail.origin }
          : { kind: 'unrecognized', at: tail.id, type: tail.type },
      };
    }
    if (depth >= DEPTH) return { steps, end: { kind: 'too-deep', at: tail.id } };
    return { steps, end: { kind: 'broken', at: tail.id, missing: tail.cause } };
  }

  /** U8: ask forwards "what became of my request". */
  became(id: string): readonly Step[] {
    return (this.#db.prepare(FORWARD).all(id, id) as unknown as Row[]).map(toStep);
  }

  /**
   * One class of traces, start to end, in order. The intent tree's fold reads from here (design/intent.md 1.2):
   * the fold has no storage of its own; it regrows from here every time.
   * Prefixes match literally, not as patterns — `_` here is just an underscore.
   */
  ofType(prefix: string): readonly Step[] {
    const rows = this.#q(
      `SELECT ${COLS} FROM trace WHERE substr(type, 1, length(?)) = ? ORDER BY id`,
    ).all(prefix, prefix) as unknown as Row[];
    return rows.map(toStep);
  }

  /**
   * Whether the human spoke again after this row. The "unanswered" boundary rests on this (design/intent.md 3.2):
   * the boundary is the conversation's own rhythm, not the wall clock — a timer wrongs the agent whenever I am busy today,
   * and a check that can wrong someone is as bad as a check that never says no.
   *
   * `'%:human:%'` matches exactly the middle segment: the door pins actor at exactly three segments (two colons),
   * so a human flanked by colons can only land in the middle.
   */
  humanSpokeAfter(id: string): boolean {
    return this.#q(
      `SELECT 1 FROM trace WHERE id > ? AND actor LIKE '%:human:%' LIMIT 1`,
    ).get(id) !== undefined;
  }

  /** U9: what happened recently. **Routine is excluded by default**; ask explicitly for everything. */
  recent(o: { limit?: number; includeRoutine?: boolean } = {}): readonly Step[] {
    const rows = this.#db.prepare(
      `SELECT ${COLS} FROM trace WHERE (? = 1 OR routine = 0) ORDER BY id DESC LIMIT ?`,
    ).all(o.includeRoutine === true ? 1 : 0, o.limit ?? 50) as unknown as Row[];
    return rows.map(toStep);
  }

  /**
   * U12: component output. **Bypass interception, not active reporting** — components just write to stdout,
   * systemd pipes it to files, and here the files enter the traces. **No one needs to remember an extra command.**
   *
   * The idempotency key is a pure function: same file, same position, same line — always the same key. No number of scans double-records.
   */
  absorb(dir: string): number {
    let n = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.log')) continue;
      const part = f.slice(0, -'.log'.length);
      const path = `${dir}/${f}`;
      const lines = readFileSync(path, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || line === '') continue;
        const idem = createHash('sha256').update(`${path}:${i}:${line}`).digest('hex');
        if (this.#byIdem(idem) !== null) continue;
        this.record({
          actor: `part:${part}:stdout`, type: 'part.output',
          origin: 'arrived-from-outside', payload: { part, line }, idem,
        });
        n++;
      }
    }
    return n;
  }

  /**
   * U11: old data downsamples, **is not deleted** (standard practice since RRDtool 1999 and still in Prometheus:
   * older means lower resolution, never gone).
   *
   * Folds only routine, and **only what nothing points to** — anything serving as a prior step or basis is untouched.
   * Not by the claim that routine is rarely cited — it is queried; plus `foreign_keys = ON`
   * as a second line: deleting a pointed-to row fails on the spot instead of leaving a broken link.
   */
  compact(o: { olderThanDays: number }): { folded: number; summaries: number } {
    const cutoff = new Date(this.#now() - o.olderThanDays * 86_400_000).toISOString();
    const victims = this.#db.prepare(`
      SELECT id, substr(ts, 1, 10) AS day, type FROM trace
       WHERE routine = 1 AND ts < ? AND type <> 'trace.compacted'
         AND id NOT IN (SELECT cause FROM trace WHERE cause IS NOT NULL)
         AND id NOT IN (SELECT j.value FROM trace, json_each(trace.payload, '$.basis') j)
    `).all(cutoff) as unknown as { id: string; day: string; type: string }[];
    if (victims.length === 0) return { folded: 0, summaries: 0 };

    const counts = new Map<string, number>();
    for (const v of victims) {
      const key = `${v.day} ${v.type}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const del = this.#db.prepare('DELETE FROM trace WHERE id = ?');
      for (const v of victims) del.run(v.id);
      for (const [key, count] of counts) {
        const [day = '', type = ''] = key.split(' ');
        this.record({
          actor: 'system:trace:compact', type: 'trace.compacted', origin: 'clock-fired',
          payload: { day, type, count },
        });
      }
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    return { folded: victims.length, summaries: counts.size };
  }

  close(): void {
    this.#db.close();
  }

  #byIdem(idem: string): Step | null {
    const row = this.#q(`SELECT ${COLS} FROM trace WHERE idem = ?`).get(idem) as Row | undefined;
    return row === undefined ? null : toStep(row);
  }

  /** The same SQL compiles once. Feeding a month of old ledger, this is worth roughly tenfold. */
  #q(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (s === undefined) { s = this.#db.prepare(sql); this.#stmts.set(sql, s); }
    return s;
  }

  /**
   * ULID: time-sortable, unique without any coordination. Consecutive writes in the same millisecond increment the random part,
   * so **one writer's numbers strictly increase**.
   *
   * A clock running backwards is **not smoothed over**: numbers reflect the moment truthfully. So a slow-clocked writer pointing at a later
   * At record time, `CHECK (cause < id)` rejects on the spot — which is exactly why it exists.
   */
  #mint(): { id: string; ts: string } {
    const ms = Math.floor(this.#now());
    if (ms === this.#lastMs) {
      this.#lastRand += 1n;
      if (this.#lastRand >= RAND_MAX) { this.#lastMs += 1; this.#lastRand = rand80(); }
    } else {
      this.#lastMs = ms;
      this.#lastRand = rand80();
    }
    return {
      id: encodeTime(this.#lastMs) + encodeRand(this.#lastRand),
      ts: new Date(this.#lastMs).toISOString(),
    };
  }
}

const ORIGINS: ReadonlySet<string> = new Set(['you-said', 'clock-fired', 'arrived-from-outside']);

function toStep(row: Row): Step {
  const p = JSON.parse(row.payload) as { origin?: unknown; basis?: unknown; body?: unknown };
  const origin = typeof p.origin === 'string' && ORIGINS.has(p.origin) ? p.origin as Origin : null;
  return {
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    type: row.type,
    cause: row.cause,
    origin,
    routine: row.routine === 1,
    basis: Array.isArray(p.basis) ? p.basis as string[] : [],
    payload: (p.body ?? {}) as Record<string, unknown>,
  };
}
