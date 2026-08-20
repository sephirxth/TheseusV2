/**
 * 画布的服务端：Node 内建 http 上的一层薄适配器，零框架。
 *
 * 它只做四件事，每件都薄：
 *
 *  1. 把折叠出来的意图树原样交给前端（GET /api/tree）。树没有第二份存储——
 *     每次都从痕迹现场折叠（src/intent.ts），画布上看到的就是真的（U32）。
 *  2. 存人摆的位置和写的便签（GET/PUT /api/layout）。照维度透镜那次的教训：
 *     **布局里只许有位置、便签、视口，运行真相字段一个也进不来**，
 *     认不出的字段当场拒、点名。镜像归真相，原生归我。
 *  3. 替面板开人的门（POST /api/act）。面板是人的门之一（design/intent.md 2.3）：
 *     点按钮就是开口——落一条 `canvas.said`（user:human:canvas），
 *     再由 `tool:canvas` 走 agent 的门写意图痕迹。判据原样生效，画布上不再造一道。
 *  4. 有变化就喊一声（GET /api/events，SSE）。前端听到了自己来取，服务端不推数据。
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

/** 布局这道门拒了。理由必须说得出来。 */
class LayoutRefused extends Error {
  override readonly name = 'LayoutRefused';
}

// ─────────────────────────────── 布局：只有位置、便签、视口 ───────────────────────────────

// `s` 是创建时的缩放尺度（世界尺寸倍率）：缩得远建的东西大，凑近建的小——
// 大小本身是人赋予的语义（2021 年那句"字号表意，但我不想知道字号是多少"）。
interface Note { id: string; x: number; y: number; w?: number; h?: number; s?: number; text: string }
interface Layout {
  positions: Record<string, { x: number; y: number; s?: number }>;
  notes: Note[];
  viewport?: { x: number; y: number; zoom: number };
}

const aNumber = (v: unknown, at: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new LayoutRefused(`${at} 不是一个有限的数`);
  return v;
};
const aString = (v: unknown, at: string): string => {
  if (typeof v !== 'string') throw new LayoutRefused(`${at} 不是字符串`);
  return v;
};
const onlyKeys = (o: object, allowed: readonly string[], at: string): void => {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      throw new LayoutRefused(`${at} 里不认识的字段 '${k}' —— 运行真相不进布局，布局里只有位置和我写的东西`);
    }
  }
};

/** 递归核对整份布局。认不出的字段当场拒——这不是防御性编程，是 U32 的边界本身。 */
function checkLayout(raw: unknown): Layout {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LayoutRefused('布局必须是一个对象');
  }
  onlyKeys(raw, ['positions', 'notes', 'viewport'], '布局');
  const r = raw as Record<string, unknown>;

  const positions: Layout['positions'] = {};
  if (r['positions'] !== undefined) {
    const p = r['positions'];
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new LayoutRefused('positions 必须是对象');
    for (const [id, pos] of Object.entries(p)) {
      if (typeof pos !== 'object' || pos === null) throw new LayoutRefused(`positions['${id}'] 必须是对象`);
      onlyKeys(pos, ['x', 'y', 's'], `positions['${id}']`);
      const q = pos as Record<string, unknown>;
      positions[id] = { x: aNumber(q['x'], `positions['${id}'].x`), y: aNumber(q['y'], `positions['${id}'].y`) };
      if (q['s'] !== undefined) positions[id].s = aNumber(q['s'], `positions['${id}'].s`);
    }
  }

  const notes: Note[] = [];
  if (r['notes'] !== undefined) {
    if (!Array.isArray(r['notes'])) throw new LayoutRefused('notes 必须是数组');
    for (const [i, n] of (r['notes'] as unknown[]).entries()) {
      if (typeof n !== 'object' || n === null) throw new LayoutRefused(`notes[${i}] 必须是对象`);
      onlyKeys(n, ['id', 'x', 'y', 'w', 'h', 's', 'text'], `notes[${i}]`);
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
      notes.push(note);
    }
  }

  const out: Layout = { positions, notes };
  if (r['viewport'] !== undefined) {
    const v = r['viewport'];
    if (typeof v !== 'object' || v === null) throw new LayoutRefused('viewport 必须是对象');
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
    return { positions: {}, notes: [] };  // 没有或坏了：从空布局开始。真相无损，丢的只是摆法。
  }
}

/** 写布局：先写旁边再换名，别让一次断电留下半份。 */
async function writeLayout(l: Layout): Promise<void> {
  const tmp = `${LAYOUT}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(l, null, 1));
  await rename(tmp, LAYOUT);
}

// ─────────────────────────────── 树：现场折叠，原样交出 ───────────────────────────────

interface TreeNodeOut {
  id: string; saying: string; parent: string | null;
  status: 'open' | 'done' | 'dropped'; mergedWith: readonly string[]; lastTouched: string;
  bornOf: { id: string; text: string; ts: string } | null;
  /** 认下的是哪条提议（幽灵实体化之后，前端靠它接上幽灵树的边）。 */
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
 * 还没被回应的提议（agent 提的、树上不算数的那些）。前端把它们画成幽灵树。
 * "被回应"只认树的动词——提议之间的引用（父子）不算回应。
 */
function proposalsJson(): { id: string; text: string; ts: string; parent: string | null }[] {
  return trace.ofType('intent.proposed')
    .filter((p) => !trace.became(p.id).some(
      (s) => s.type.startsWith('intent.') && s.type !== 'intent.proposed',
    ))
    .map((p) => ({
      id: p.id, text: String(p.payload['text'] ?? ''), ts: p.ts, parent: p.basis[0] ?? null,
    }));
}

// ─────────────────────────────── 动作：面板是人的门 ───────────────────────────────

/**
 * 点按钮就是开口。那句话先原样落进痕迹（canvas.said，人的门），
 * 意图痕迹再挂在它上面（tool:canvas，agent 的门）。动作被拒时那句话留着——
 * 我确实说了，只是这次没算数，这本身就是诚实的历史。
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
    if (text === '') throw new IntentRefused('一个节点是一句话——空的说法长不成节点');
    const accepting = typeof b['accepting'] === 'string' ? b['accepting'] : undefined;
    const under = typeof b['under'] === 'string' ? b['under'] : undefined;
    // 认在指定的老节点下：同一句话既是"回去"的授权也是"认领"的授权——
    // 两条痕迹都直接挂在它上面，判据一条不松（design/intent.md 1.4：要挂到老节点上，先回去）。
    const h = say(under !== undefined && under !== intent.tree().current ? `回到「${sayingOf(under)}」，认领：${text}` : text);
    if (under !== undefined && under !== intent.tree().current) {
      intent.resume({ said: h.id, node: under });
    }
    return { id: intent.adopt({ said: h.id, text, ...(accepting !== undefined ? { accepting } : {}) }).id };
  }
  if (kind === 'resume') {
    return { id: intent.resume({ said: say(`回到：${sayingOf(target)}`).id, node: target }).id };
  }
  if (kind === 'done') {
    return { id: intent.done({ said: say(`做完了：${sayingOf(target)}`).id, target }).id };
  }
  if (kind === 'drop') {
    const why = String(b['why'] ?? '').trim();
    if (why === '') throw new IntentRefused('没有为什么。放弃的理由是将来"要不要捡回来"的唯一依据');
    return { id: intent.drop({ said: say(`不做了：${sayingOf(target)}——${why}`).id, target, why }).id };
  }
  throw new IntentRefused(`不认识的动作 '${kind}'`);
}

// ─────────────────────────────── 有变化喊一声（SSE） ───────────────────────────────

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
    if (size > 1 << 20) throw new LayoutRefused('请求超过 1MB');
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
    json(res, 200, { hint: '前端还没构建：pnpm -C canvas build' });
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-store',  // 开发节奏优先：重发了就要看到新的（占城 dev 站同款教训）
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
    if (e instanceof SyntaxError) return json(res, 400, { error: `不是合法的 JSON: ${e.message}` });
    console.error(e);
    json(res, 500, { error: (e as Error).message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`theseus-canvas: http://127.0.0.1:${PORT}  db=${DB}  layout=${LAYOUT}`);
});
