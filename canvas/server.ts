/**
 * Canvas server: a thin adapter over Node's built-in http, zero frameworks.
 *
 * It does exactly four things, each thin:
 *
 *  1. Hand the folded intent tree to the frontend as-is (GET /api/tree). The tree has no second storage —
 *     folded from traces on every request (src/intent.ts); what the canvas shows is the truth (U32).
 *  2. Store human-placed positions and notes (GET/PUT /api/layout). Lesson from the dimension-lens incident:
 *     **layout may only hold position, notes, viewport — no runtime-truth fields may enter**,
 *     unknown fields are rejected on the spot and named. Mirrors belong to truth; natives belong to me.
 *  3. Open the human gate for the panel (POST /api/act). The panel is one of the human gates (design/intent.md 2.3):
 *     clicking a button is speaking — records a `canvas.said` (user:human:canvas),
 *     then `tool:canvas` writes intent traces through the agent gate. Criteria apply as-is; no second gate is invented on the canvas.
 *  4. Announce changes (GET /api/events, SSE). The frontend fetches on hearing; the server never pushes data.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { humanDoor } from '../src/doors.ts';
import { Intent, IntentRefused } from '../src/intent.ts';
import { Trace, TraceRefused } from '../src/trace.ts';

const PORT = Number(process.env['THESEUS_CANVAS_PORT'] ?? 8811);
const DB = process.env['THESEUS_TRACE_DB'] ?? join(homedir(), '.local/state/theseus/trace.db');
const LAYOUT = process.env['THESEUS_CANVAS_LAYOUT']
  ?? join(homedir(), '.local/state/theseus/canvas-layout.json');
const DIST = new URL('./dist', import.meta.url).pathname;

const trace = new Trace(DB);
const intent = new Intent(trace, `tool:canvas:${process.pid}`);
const human = humanDoor(trace);

/** The layout gate refused. The reason must be stateable. */
class LayoutRefused extends Error {
  override readonly name = 'LayoutRefused';
}

// ─────────────────────────────── layout: only position, notes, viewport ───────────────────────────────

// `s` is the zoom scale at creation (world-size multiplier): things created zoomed-out are large, zoomed-in small —
// size itself is human-given semantics (2021: “font size expresses meaning, but I don't want to know the number”).
interface Note { id: string; x: number; y: number; w?: number; h?: number; s?: number; t?: number; text: string }
/** Native link: human-drawn relation, mere annotation — a different thing from birth/merge edges (trace projections). */
interface Link { id: string; from: string; to: string; label?: string }
interface Layout {
  positions: Record<string, { x: number; y: number; s?: number }>;
  notes: Note[];
  links?: Link[];
  /** View projection: free layout / timeline. Same truth, multiple organizations. */
  mode?: 'free' | 'timeline';
  viewport?: { x: number; y: number; zoom: number };
}

const aNumber = (v: unknown, at: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new LayoutRefused(`${at} is not a finite number`);
  return v;
};
const aString = (v: unknown, at: string): string => {
  if (typeof v !== 'string') throw new LayoutRefused(`${at} is not a string`);
  return v;
};
const onlyKeys = (o: object, allowed: readonly string[], at: string): void => {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      throw new LayoutRefused(`${at} unknown field in '${k}'  — runtime truth does not enter layout; layout holds only positions and what I wrote`);
    }
  }
};

/** Recursively validate the whole layout. Unknown fields are rejected on the spot — not defensive programming, but the U32 boundary itself. */
function checkLayout(raw: unknown): Layout {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LayoutRefused('layout must be an object');
  }
  onlyKeys(raw, ['positions', 'notes', 'links', 'mode', 'viewport'], 'layout');
  const r = raw as Record<string, unknown>;

  const positions: Layout['positions'] = {};
  if (r['positions'] !== undefined) {
    const p = r['positions'];
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new LayoutRefused('positions must be an object');
    for (const [id, pos] of Object.entries(p)) {
      if (typeof pos !== 'object' || pos === null) throw new LayoutRefused(`positions['${id}'] must be an object`);
      onlyKeys(pos, ['x', 'y', 's'], `positions['${id}']`);
      const q = pos as Record<string, unknown>;
      positions[id] = { x: aNumber(q['x'], `positions['${id}'].x`), y: aNumber(q['y'], `positions['${id}'].y`) };
      if (q['s'] !== undefined) positions[id].s = aNumber(q['s'], `positions['${id}'].s`);
    }
  }

  const notes: Note[] = [];
  if (r['notes'] !== undefined) {
    if (!Array.isArray(r['notes'])) throw new LayoutRefused('notes must be an array');
    for (const [i, n] of (r['notes'] as unknown[]).entries()) {
      if (typeof n !== 'object' || n === null) throw new LayoutRefused(`notes[${i}] must be an object`);
      onlyKeys(n, ['id', 'x', 'y', 'w', 'h', 's', 't', 'text'], `notes[${i}]`);
      const q = n as Record<string, unknown>;
      const note: Note = {
        id: aString(q['id'], `notes[${i}].id`),
        x: aNumber(q['x'], `notes[${i}].x`),
        y: aNumber(q['y'], `notes[${i}].y`),
        text: aString(q['text'], `notes[${i}].text`),
      };
      if (q['w'] !== undefined) note.w = aNumber(q['w'], `notes[${i}].w`);
      if (q['h'] !== undefined) note.h = aNumber(q['h'], `notes[${i}].h`);
      if (q['s'] !== undefined) note.s = aNumber(q['s'], `notes[${i}].s`);
      if (q['t'] !== undefined) note.t = aNumber(q['t'], `notes[${i}].t`);
      notes.push(note);
    }
  }

  const out: Layout = { positions, notes };
  if (r['mode'] !== undefined) {
    if (r['mode'] !== 'free' && r['mode'] !== 'timeline') throw new LayoutRefused(`mode only free / timeline allowed`);
    out.mode = r['mode'];
  }
  if (r['links'] !== undefined) {
    if (!Array.isArray(r['links'])) throw new LayoutRefused('links must be an array');
    const links: Link[] = [];
    for (const [i, k] of (r['links'] as unknown[]).entries()) {
      if (typeof k !== 'object' || k === null) throw new LayoutRefused(`links[${i}] must be an object`);
      onlyKeys(k, ['id', 'from', 'to', 'label'], `links[${i}]`);
      const q = k as Record<string, unknown>;
      const link: Link = {
        id: aString(q['id'], `links[${i}].id`),
        from: aString(q['from'], `links[${i}].from`),
        to: aString(q['to'], `links[${i}].to`),
      };
      if (q['label'] !== undefined) link.label = aString(q['label'], `links[${i}].label`);
      links.push(link);
    }
    out.links = links;
  }
  if (r['viewport'] !== undefined) {
    const v = r['viewport'];
    if (typeof v !== 'object' || v === null) throw new LayoutRefused('viewport must be an object');
    onlyKeys(v, ['x', 'y', 'zoom'], 'viewport');
    const q = v as Record<string, unknown>;
    out.viewport = { x: aNumber(q['x'], 'viewport.x'), y: aNumber(q['y'], 'viewport.y'), zoom: aNumber(q['zoom'], 'viewport.zoom') };
  }
  return out;
}

async function readLayout(): Promise<Layout> {
  try {
    return checkLayout(JSON.parse(await readFile(LAYOUT, 'utf8')));
  } catch {
    return { positions: {}, notes: [] };  // missing or broken: start from an empty layout. Truth is unharmed; only the arrangement is lost.
  }
}

/** Write layout: write beside then rename, so a power cut never leaves half a file. */
async function writeLayout(l: Layout): Promise<void> {
  const tmp = `${LAYOUT}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(l, null, 1));
  await rename(tmp, LAYOUT);
}

// ─────────────────────────────── tree: folded on demand, handed over as-is ───────────────────────────────

interface TreeNodeOut {
  id: string; saying: string; parent: string | null;
  status: 'open' | 'done' | 'dropped'; mergedWith: readonly string[]; lastTouched: string;
  bornOf: { id: string; text: string; ts: string } | null;
  /** Which proposal was accepted (after ghost materialization, the frontend uses it to reconnect ghost-tree edges). */
  fromProposal: string | null;
}

function treeJson(): { current: string | null; line: string; nodes: TreeNodeOut[] } {
  const t = intent.tree();
  const nodes: TreeNodeOut[] = [...t.nodes.values()].map((n) => {
    const born = trace.get(n.id);
    const h = born !== null && born.cause !== null ? trace.get(born.cause) : null;
    return {
      id: n.id, saying: n.saying, parent: n.parent, status: n.status,
      mergedWith: n.mergedWith, lastTouched: n.lastTouched,
      bornOf: h === null ? null : { id: h.id, text: String(h.payload['text'] ?? ''), ts: h.ts },
      fromProposal: born?.basis[0] ?? null,
    };
  });
  return { current: t.current, line: intent.line(), nodes };
}

/**
 * Proposals not yet answered (agent-proposed, not counted on the tree). The frontend renders them as a ghost tree.
 * “Answered” only counts tree verbs — references between proposals (parent/child) do not count as answers.
 *
 * When the same guess was proposed multiple times (e.g. re-proposed with fuller information), only the latest is shown:
 * dedup by parent-text|text keeping the highest number — and dedup happens **before** the answered-filter,
 * so after the latest is accepted, the old one does not reappear.
 */
function proposalsJson(): { id: string; text: string; at: string | null; ts: string; parent: string | null }[] {
  const all = trace.ofType('intent.proposed').map((p) => ({
    id: p.id,
    text: String(p.payload['text'] ?? ''),
    at: typeof p.payload['at'] === 'string' ? p.payload['at'] : null,
    ts: p.ts,
    parent: p.basis[0] ?? null,
  }));
  const textOf = new Map(all.map((r) => [r.id, r.text]));
  const best = new Map<string, typeof all[number]>();
  for (const r of all) {
    const key = `${r.parent !== null ? (textOf.get(r.parent) ?? r.parent) : ''}|${r.text}`;
    const prev = best.get(key);
    if (prev === undefined || prev.id < r.id) best.set(key, r);
  }
  return [...best.values()]
    .filter((p) => !trace.became(p.id).some(
      (s) => s.type.startsWith('intent.') && s.type !== 'intent.proposed',
    ))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ─────────────────────────────── actions: the panel is a human gate ───────────────────────────────

/**
 * Clicking a button is speaking. The utterance is recorded verbatim into traces first (canvas.said, human gate),
 * then intent traces attach to it (tool:canvas, agent gate). If the action is refused the utterance stays —
 * I did say it; it just did not count this time — which is itself honest history.
 */
function act(b: Record<string, unknown>): { id: string } {
  const say = (text: string) => human.record({
    actor: 'user:human:canvas', type: 'canvas.said', origin: 'you-said', payload: { text },
  });
  const sayingOf = (id: string): string => intent.tree().nodes.get(id)?.saying ?? id;
  const kind = String(b['kind'] ?? '');
  const target = String(b['target'] ?? '');

  if (kind === 'adopt') {
    const text = String(b['text'] ?? '').trim();
    if (text === '') throw new IntentRefused('a node is an utterance — an empty saying cannot grow into a node');
    const accepting = typeof b['accepting'] === 'string' ? b['accepting'] : undefined;
    const under = typeof b['under'] === 'string' ? b['under'] : undefined;
    // Accept under a specified old node: the same utterance authorizes both the resume and the acceptance —
    // both traces hang directly on it, not one criterion loosened (design/intent.md 1.4: to hang on an old node, first go back).
    const h = say(under !== undefined && under !== intent.tree().current ? `resume at '${sayingOf(under)}', accept: ${text}` : text);
    if (under !== undefined && under !== intent.tree().current) {
      intent.resume({ said: h.id, node: under });
    }
    return { id: intent.adopt({ said: h.id, text, ...(accepting !== undefined ? { accepting } : {}) }).id };
  }
  if (kind === 'resume') {
    return { id: intent.resume({ said: say(`resume: ${sayingOf(target)}`).id, node: target }).id };
  }
  if (kind === 'done') {
    return { id: intent.done({ said: say(`done: ${sayingOf(target)}`).id, target }).id };
  }
  if (kind === 'drop') {
    const why = String(b['why'] ?? '').trim();
    if (why === '') throw new IntentRefused('no why given. The drop reason is the only basis for deciding whether to pick it back up later');
    return { id: intent.drop({ said: say(`drop: ${sayingOf(target)} — ${why}`).id, target, why }).id };
  }
  if (kind === 'merge') {
    const a = String(b['a'] ?? '');
    const bb = String(b['b'] ?? '');
    const why = String(b['why'] ?? '').trim();
    const h = say(`same thing: '${sayingOf(a)}' and '${sayingOf(bb)}'${why !== '' ? ` — ${why}` : ''}`);
    return { id: intent.merge({ said: h.id, a, b: bb, ...(why !== '' ? { why } : {}) }).id };
  }
  throw new IntentRefused(`unknown action '${kind}'`);
}

// ─────────────────────────────── announce changes (SSE) ───────────────────────────────

const listeners = new Set<ServerResponse>();
let lastHash = '';
setInterval(() => {
  const hash = createHash('sha256')
    .update(JSON.stringify(treeJson()))
    .update(JSON.stringify(proposalsJson()))
    .digest('hex');
  if (hash === lastHash) return;
  lastHash = hash;
  for (const res of listeners) res.write('data: changed\n\n');
}, 1500).unref();
setInterval(() => {
  for (const res of listeners) res.write(': ping\n\n');
}, 25_000).unref();

// ─────────────────────────────── http ───────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json',
};

const json = (res: ServerResponse, code: number, body: unknown): void => {
  const buf = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(buf);
};

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1 << 20) throw new LayoutRefused('request exceeds 1MB');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : JSON.parse(text);
}

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const rel = path === '/' ? '/index.html' : path;
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST)) { json(res, 404, { error: 'not found' }); return; }
  const target = existsSync(file) ? file : join(DIST, 'index.html');
  if (!existsSync(target)) {
    json(res, 200, { hint: 'frontend not built yet: pnpm -C canvas build' });
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-store',  // dev-rhythm first: a reload must show the new thing (same lesson as the conquest dev site)
  });
  res.end(await readFile(target));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, db: DB });
    if (url.pathname === '/api/tree' && req.method === 'GET') return json(res, 200, treeJson());
    if (url.pathname === '/api/proposals' && req.method === 'GET') return json(res, 200, proposalsJson());
    if (url.pathname === '/api/layout' && req.method === 'GET') return json(res, 200, await readLayout());
    if (url.pathname === '/api/layout' && req.method === 'PUT') {
      await writeLayout(checkLayout(await body(req)));
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/api/act' && req.method === 'POST') {
      return json(res, 200, act(await body(req) as Record<string, unknown>));
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
      });
      res.write(': hello\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    if (req.method === 'GET') return await serveStatic(url.pathname, res);
    json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    if (e instanceof IntentRefused || e instanceof TraceRefused || e instanceof LayoutRefused) {
      return json(res, 400, { error: `${(e as Error).name}: ${(e as Error).message}` });
    }
    if (e instanceof SyntaxError) return json(res, 400, { error: `invalid JSON: ${e.message}` });
    console.error(e);
    json(res, 500, { error: (e as Error).message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`theseus-canvas: http://127.0.0.1:${PORT}  db=${DB}  layout=${LAYOUT}`);
});
