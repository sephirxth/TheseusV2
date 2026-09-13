// Five lines to the server: tree (folded on demand), proposals (ghosts), layout (position+notes+links+view),
// actions (the human gate), change notifications.

export interface TreeNode {
  id: string;
  saying: string;
  parent: string | null;
  status: 'open' | 'done' | 'dropped';
  mergedWith: string[];
  lastTouched: string;
  bornOf: { id: string; text: string; ts: string } | null;
  fromProposal: string | null;
}
export interface TreeData { current: string | null; line: string; nodes: TreeNode[] }

/** Agent-proposed, not yet answered: rendered as a ghost; joins the tree once accepted. at = registration date of the thing it refers to. */
export interface Proposal { id: string; text: string; at: string | null; ts: string; parent: string | null }

export interface Note { id: string; x: number; y: number; w?: number; h?: number; s?: number; t?: number; text: string }
/** Native link: human-drawn relation annotation — a different thing from birth/merge edges (trace projections). */
export interface Link { id: string; from: string; to: string; label?: string }
export interface Layout {
  positions: Record<string, { x: number; y: number; s?: number }>;
  notes: Note[];
  links?: Link[];
  mode?: 'free' | 'timeline';
  viewport?: { x: number; y: number; zoom: number };
}

async function must(res: Response): Promise<Response> {
  if (res.ok) return res;
  let msg = `${res.status}`;
  try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* 原样 */ }
  throw new Error(msg);
}

export const fetchTree = async (): Promise<TreeData> =>
  (await must(await fetch('/api/tree'))).json() as Promise<TreeData>;

export const fetchProposals = async (): Promise<Proposal[]> =>
  (await must(await fetch('/api/proposals'))).json() as Promise<Proposal[]>;

export const fetchLayout = async (): Promise<Layout> =>
  (await must(await fetch('/api/layout'))).json() as Promise<Layout>;

export const saveLayout = async (l: Layout): Promise<void> => {
  await must(await fetch('/api/layout', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(l),
  }));
};

export const act = async (
  kind: 'adopt' | 'resume' | 'done' | 'drop' | 'merge',
  params: { text?: string; target?: string; why?: string; accepting?: string; under?: string; a?: string; b?: string },
): Promise<{ id: string }> => {
  const res = await must(await fetch('/api/act', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, ...params }),
  }));
  return res.json() as Promise<{ id: string }>;
};

/** The server only says something changed; fetching stays pull-based. */
export function onChange(cb: () => void): () => void {
  const es = new EventSource('/api/events');
  es.onmessage = cb;
  return () => es.close();
}
