/**
 * Seed still-living nodes of the old system's intent tree (L2 projection tree.md) into traces as **proposals**.
 *
 * Why proposals and not nodes: only what I accept gets on the tree (U19-6); an agent cannot fabricate a human utterance.
 * Old-tree nodes are real, but whether I still want them is a human call only — so they enter as
 * `intent.proposed` (agents may propose freely; none grow onto the tree), rendered as ghosts,
 * the click of acceptance is the authorization.
 *
 * Seed only 🔵 active and ⏸ suspended; ✅ closed and ❌ dropped are history, handled by the U13 migration round.
 * Parent-child goes into the proposal's basis (proposal-referencing-proposal does not count as answered).
 * Idempotent: seeding the same one any number of times yields one row.
 *
 * Usage: node canvas/scripts/seed-proposals.ts <path to tree.md>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Intent } from '../../src/intent.ts';
import { Trace } from '../../src/trace.ts';

const file = process.argv[2];
if (file === undefined) {
  console.error('Usage: node canvas/scripts/seed-proposals.ts <path to tree.md>');
  process.exit(2);
}
const DB = process.env['THESEUS_TRACE_DB'] ?? join(homedir(), '.local/state/theseus/trace.db');

const raw = readFileSync(file, 'utf8');
const body = raw.includes('## tree') ? raw.slice(raw.indexOf('## tree')) : raw;

const PAT = /^(\s*)- \[(🔵|⏸|✅|❌)\] (.+?)(?:\s*\((\d{4}-\d{2}-\d{2})\))?\s*(?:—|$)/u;

interface Row { indent: number; status: string; name: string; at: string | null }
const rows: Row[] = [];
for (const ln of body.split('\n')) {
  const m = PAT.exec(ln);
  if (m === null) continue;
  rows.push({
    indent: (m[1] ?? '').length, status: m[2] ?? '', name: (m[3] ?? '').trim(),
    at: m[4] ?? null,                              // date registered on the old tree; the timeline places by it
  });
}

const trace = new Trace(DB);
const intent = new Intent(trace, 'agent:claude:seed-oldtree');

// Walk by indentation: remember the nearest seeded ancestor per level; attach parent-child to the nearest living ancestor.
const stack: { indent: number; id: string | null }[] = [];
let seeded = 0;
let skipped = 0;
for (const r of rows) {
  while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= r.indent) stack.pop();
  const parent = [...stack].reverse().find((s) => s.id !== null)?.id ?? null;
  if (r.status !== '🔵' && r.status !== '⏸') {
    stack.push({ indent: r.indent, id: null });
    skipped++;
    continue;
  }
  const text = r.status === '⏸' ? `${r.name} ⏸` : r.name;
  const idem = `seed:oldtree:${createHash('sha256').update(`${parent ?? ''}|${r.name}|${r.at ?? ''}`).digest('hex')}`;
  const step = intent.propose({
    text,
    origin: 'arrived-from-outside',
    ...(parent !== null ? { about: [parent] } : {}),
    ...(r.at !== null ? { at: r.at } : {}),
    idem,
  });
  stack.push({ indent: r.indent, id: step.id });
  seeded++;
}
console.log(`seeded ${seeded} proposals (skipped ${skipped} closed/dropped) -> ${DB}`);
trace.close();
