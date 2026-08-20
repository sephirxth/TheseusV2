// 和服务端的四条线：树（现场折叠）、布局（位置+便签）、动作（人的门）、变更通知。

export interface TreeNode {
  id: string;
  saying: string;
  parent: string | null;
  status: 'open' | 'done' | 'dropped';
  mergedWith: string[];
  lastTouched: string;
  bornOf: { id: string; text: string; ts: string } | null;
}
export interface TreeData { current: string | null; line: string; nodes: TreeNode[] }

export interface Note { id: string; x: number; y: number; w?: number; h?: number; text: string }
export interface Layout {
  positions: Record<string, { x: number; y: number }>;
  notes: Note[];
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

export const fetchLayout = async (): Promise<Layout> =>
  (await must(await fetch('/api/layout'))).json() as Promise<Layout>;

export const saveLayout = async (l: Layout): Promise<void> => {
  await must(await fetch('/api/layout', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(l),
  }));
};

export const act = async (
  kind: 'adopt' | 'resume' | 'done' | 'drop',
  params: { text?: string; target?: string; why?: string },
): Promise<void> => {
  await must(await fetch('/api/act', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, ...params }),
  }));
};

/** 服务端只喊"变了"，取数还是主动来取。 */
export function onChange(cb: () => void): () => void {
  const es = new EventSource('/api/events');
  es.onmessage = cb;
  return () => es.close();
}
