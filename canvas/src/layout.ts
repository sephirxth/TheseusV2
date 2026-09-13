// Things never placed by a human get a deterministic initial position: a tidy tree (leaves on rows, parents centered over subtrees,
// gaps between roots). Initial value only — once a human drags, the position belongs to the human (U31); this code never touches it again.

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
    if (seen.has(n.id)) return row;          // guard: cycles in data cannot loop forever
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
    row += ROOT_GAP;                          // two blank rows between roots
  }

  for (const id of Object.keys(placed)) delete out[id];   // human-placed: never touched
  return out;
}
