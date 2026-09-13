/**
 * ★C — which types count as "routine". A judgment specific to this system; no one else can make it for us.
 *
 * The scope follows the five classes fixed in docs/acceptance/trace.md, verbatim:
 * clock ticks, the trigger's own bookkeeping, scheduled hauling, proactive-thinking cycle start, proactive-thinking concluding "nothing to do".
 *
 * **Tag at write time, never guess at read time** (syslog practice since the 1980s). Guessing at read time guesses wrong,
 * and unstably so — this line filtered today, not tomorrow.
 *
 * Two notes:
 *  (1) `ingest.*` is a prefix, not only `ingest.transcripts`. The spec's stated reason is "mechanical hauling, no semantics",
 *      which holds verbatim for `ingest.roam` — and what stamped 2300 documents on 2026-06-10
 *      was exactly `ingest.roam`. Recognizing only one type name, that compliant stamp would go unrecognized.
 *  (2) `trace.compacted` is downsampling's own bookkeeping, equally routine.
 */
const ROUTINE_TYPES: ReadonlySet<string> = new Set([
  'time.tick',                      // clock tick
  'watcher.fired',                  // the trigger's own bookkeeping
  'proactive_thinking.started',     // proactive-thinking cycle start
  'proactive_thinking.quiet',       // proactive thinking concludes: nothing to do
  'trace.compacted',                // downsampling's own bookkeeping
]);

/** Mechanical hauling, no semantics. **Not a heartbeat** — every row really hauls files, yet still routine. */
const ROUTINE_PREFIXES: readonly string[] = ['ingest.'];

export const isRoutine = (type: string): boolean =>
  ROUTINE_TYPES.has(type) || ROUTINE_PREFIXES.some((p) => type.startsWith(p));
