/**
 * Seed still-living nodes of the old system's intent tree (L2 projection tree.md) into traces as **proposals**.
 *
 * Why proposals and not nodes: only what I accept gets on the tree (U19-6); an agent cannot fabricate a human utterance.
 * 旧树的节点是真的，但"我现在还要不要它"只有人说了算——所以它们以
 * `intent.proposed` 进来（agent 随便提，一条也不长树），在画布上显示为幽灵，
 * 人点一下"认领"，那一下才是授权。
 *
 * 只种 🔵 活跃 和 ⏸ 挂起；✅ 闭环 和 ❌ 放弃 是历史，归 U13 迁移轮管。
 * 父子关系放进提议的 basis（提议引用提议不算"被回应"）。
 * 幂等：同一条种多少遍都只有一条。
 *
 * 用法：node canvas/scripts/seed-proposals.ts <tree.md 路径>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Intent } from '../../src/intent.ts';
import { Trace } from '../../src/trace.ts';

const file = process.argv[2];
if (file === undefined) {
  console.error('用法：node canvas/scripts/seed-proposals.ts <tree.md 路径>');
  process.exit(2);
}
const DB = process.env['THESEUS_TRACE_DB'] ?? join(homedir(), '.local/state/theseus/trace.db');

const raw = readFileSync(file, 'utf8');
const body = raw.includes('## 树') ? raw.slice(raw.indexOf('## 树')) : raw;

const PAT = /^(\s*)- \[(🔵|⏸|✅|❌)\] (.+?)(?:\s*\((\d{4}-\d{2}-\d{2})\))?\s*(?:—|$)/u;

interface Row { indent: number; status: string; name: string; at: string | null }
const rows: Row[] = [];
for (const ln of body.split('\n')) {
  const m = PAT.exec(ln);
  if (m === null) continue;
  rows.push({
    indent: (m[1] ?? '').length, status: m[2] ?? '', name: (m[3] ?? '').trim(),
    at: m[4] ?? null,                              // 旧树上登记的日期：时间轴靠它落位
  });
}

const trace = new Trace(DB);
const intent = new Intent(trace, 'agent:claude:seed-oldtree');

// 沿缩进走：记住每一层最近一个**被种下**的祖先，父子接到最近的活祖先上。
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
console.log(`种下 ${seeded} 条提议（跳过已闭环/放弃 ${skipped} 条）→ ${DB}`);
trace.close();
