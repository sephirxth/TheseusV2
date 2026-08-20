// 没被人摆过的节点，给一个确定性的初始位置：按出生深度排列（根在左）。
// 只是初始值——人一拖，位置就归人（U31），这里再也不碰它。

import type { TreeNode } from './api';

export function autoPlace(
  nodes: TreeNode[],
  placed: Record<string, { x: number; y: number }>,
): Record<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthOf = (n: TreeNode): number => {
    let d = 0;
    for (let p = n.parent; p !== null; d++) p = byId.get(p)?.parent ?? null;
    return d;
  };
  const lanes = new Map<number, number>();
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (placed[n.id] !== undefined) continue;
    const d = depthOf(n);
    const lane = lanes.get(d) ?? 0;
    lanes.set(d, lane + 1);
    out[n.id] = { x: 60 + d * 320, y: 80 + lane * 130 + (d % 2) * 40 };
  }
  return out;
}
