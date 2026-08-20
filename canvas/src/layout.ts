// 没被人摆过的东西，给一个确定性的初始位置：整齐树（叶子占行、父亲居中于子树、
// 根与根之间留空）。只是初始值——人一拖，位置就归人（U31），这里再也不碰它。

export interface Placeable { id: string; parent: string | null }

const COL = 360;
const ROW = 96;
const ROOT_GAP = 2;

export function autoPlace(
  items: Placeable[],
  placed: Record<string, { x: number; y: number }>,
): Record<string, { x: number; y: number }> {
  const byId = new Map(items.map((n) => [n.id, n]));
  const kids = new Map<string, Placeable[]>();
  const roots: Placeable[] = [];
  for (const n of [...items].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const p = n.parent !== null && byId.has(n.parent) ? n.parent : null;
    if (p === null) roots.push(n);
    else {
      const list = kids.get(p) ?? [];
      list.push(n);
      kids.set(p, list);
    }
  }

  const out: Record<string, { x: number; y: number }> = {};
  let row = 0;
  const visit = (n: Placeable, depth: number, seen: Set<string>): number => {
    if (seen.has(n.id)) return row;          // 防御：数据里出现环也不至于转死
    seen.add(n.id);
    const children = kids.get(n.id) ?? [];
    let y: number;
    if (children.length === 0) {
      y = row * ROW;
      row += 1;
    } else {
      const ys = children.map((c) => visit(c, depth + 1, seen));
      y = ((ys[0] ?? 0) + (ys[ys.length - 1] ?? 0)) / 2;
    }
    out[n.id] = { x: 60 + depth * COL, y: 80 + y };
    return y;
  };
  const seen = new Set<string>();
  for (const r of roots) {
    visit(r, 0, seen);
    row += ROOT_GAP;                          // 根与根之间留两行空
  }

  for (const id of Object.keys(placed)) delete out[id];   // 人摆过的，一律不碰
  return out;
}
