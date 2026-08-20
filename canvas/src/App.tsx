import {
  Background, Controls, MiniMap, ReactFlow, useNodesState, useReactFlow,
  MarkerType, type Edge, type NodeMouseHandler, type OnNodeDrag,
} from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { act, fetchLayout, fetchProposals, fetchTree, onChange, saveLayout } from './api';
import type { Layout, Proposal, TreeData, TreeNode } from './api';
import { autoPlace, type Placeable } from './layout';
import {
  GhostNodeView, IntentNodeView, NoteNodeView,
  type GhostFlowNode, type IntentFlowNode, type NoteFlowNode,
} from './nodes';

type CanvasNode = IntentFlowNode | GhostFlowNode | NoteFlowNode;

const nodeTypes = { intent: IntentNodeView, ghost: GhostNodeView, note: NoteNodeView };

const isSuspended = (t: string): boolean => / ⏸$/u.test(t);
const cleanText = (t: string): string => t.replace(/ ⏸$/u, '');
/** 创建时的世界尺度 = 1/当时的缩放，夹在可读范围里。 */
const clampScale = (v: number): number => Math.min(10, Math.max(0.35, v));

export default function App() {
  const [tree, setTree] = useState<TreeData | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sayText, setSayText] = useState('');
  const [whyText, setWhyText] = useState('');
  const [err, setErr] = useState('');
  const dirty = useRef(false);
  /** 本次渲染里每个东西实际落在哪（含自动摆位的），认领实体化时按这个原位落地。 */
  const posRef = useRef<Record<string, { x: number; y: number; s: number }>>({});
  const { screenToFlowPosition, getViewport } = useReactFlow();

  const oops = (e: unknown) => {
    setErr(e instanceof Error ? e.message : String(e));
    setTimeout(() => setErr(''), 5000);
  };

  const reload = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([fetchTree(), fetchProposals()]);
      setTree(t); setProposals(p);
    } catch (e) { oops(e); }
  }, []);

  // 开场：树、提议、布局；然后听着——服务端喊"变了"就再取。
  useEffect(() => {
    void (async () => {
      try {
        const [t, p, l] = await Promise.all([fetchTree(), fetchProposals(), fetchLayout()]);
        setTree(t); setProposals(p); setLayout(l);
      } catch (e) { oops(e); }
    })();
    return onChange(() => { void reload(); });
  }, [reload]);

  // 布局归人：改了就存，存的只有位置、尺度和便签。
  useEffect(() => {
    if (layout === null || !dirty.current) return;
    const t = setTimeout(() => { dirty.current = false; saveLayout(layout).catch(oops); }, 400);
    return () => clearTimeout(t);
  }, [layout]);

  const mutateLayout = useCallback((fn: (l: Layout) => Layout) => {
    setLayout((l) => { if (l === null) return l; dirty.current = true; return fn(l); });
  }, []);

  const noteText = useCallback((id: string, text: string) => {
    mutateLayout((l) => ({ ...l, notes: l.notes.map((n) => (n.id === id ? { ...n, text } : n)) }));
  }, [mutateLayout]);

  const noteRemove = useCallback((id: string) => {
    mutateLayout((l) => ({ ...l, notes: l.notes.filter((n) => n.id !== id) }));
  }, [mutateLayout]);

  /** 幽灵实体化：认领=一句真话过人的门；有已认领的祖先就先"回到"它名下再认。 */
  const adoptGhost = useCallback(async (pid: string) => {
    if (tree === null) return;
    const byId = new Map(proposals.map((x) => [x.id, x]));
    const p = byId.get(pid);
    if (p === undefined) return;
    const adoptedByProposal = new Map(
      tree.nodes.filter((n) => n.fromProposal !== null).map((n) => [n.fromProposal as string, n.id]),
    );
    let under: string | undefined;
    for (let q = p.parent; q !== null; q = byId.get(q)?.parent ?? null) {
      const hit = adoptedByProposal.get(q);
      if (hit !== undefined) { under = hit; break; }
    }
    const pos = posRef.current[pid] ?? { x: 0, y: 0, s: 1 };
    try {
      const { id: newId } = await act('adopt', {
        text: cleanText(p.text), accepting: pid, ...(under !== undefined ? { under } : {}),
      });
      mutateLayout((l) => ({
        ...l,
        positions: { ...l.positions, [newId]: { x: pos.x, y: pos.y, ...(pos.s !== 1 ? { s: pos.s } : {}) } },
      }));
      await reload();
    } catch (e) { oops(e); }
  }, [tree, proposals, mutateLayout, reload]);

  // 树（镜像）+ 提议（幽灵）+ 便签（原生）→ 画布。位置：人摆过的用人摆的，没摆过的给初始值。
  useEffect(() => {
    if (tree === null || layout === null) return;
    const adoptedByProposal = new Map(
      tree.nodes.filter((n) => n.fromProposal !== null).map((n) => [n.fromProposal as string, n.id]),
    );
    const union: Placeable[] = [
      ...tree.nodes.map((n) => ({ id: n.id, parent: n.parent })),
      ...proposals.map((p) => ({
        id: p.id,
        parent: p.parent !== null ? (adoptedByProposal.get(p.parent) ?? p.parent) : null,
      })),
    ];
    const auto = autoPlace(union, layout.positions);
    const at = (id: string): { x: number; y: number; s: number } => {
      const stored = layout.positions[id];
      const base = stored ?? auto[id] ?? { x: 0, y: 0 };
      return { x: base.x, y: base.y, s: stored?.s ?? 1 };
    };
    const pmap: Record<string, { x: number; y: number; s: number }> = {};
    for (const u of union) pmap[u.id] = at(u.id);
    posRef.current = pmap;

    const intentNodes: CanvasNode[] = tree.nodes.map((n) => {
      const p = at(n.id);
      return {
        id: n.id, type: 'intent' as const, position: { x: p.x, y: p.y },
        data: {
          saying: n.saying, status: n.status, isCurrent: tree.current === n.id,
          mergedCount: n.mergedWith.length, bornText: n.bornOf?.text ?? '', s: p.s,
        },
      };
    });
    const ghostNodes: CanvasNode[] = proposals.map((g) => {
      const p = at(g.id);
      return {
        id: g.id, type: 'ghost' as const, position: { x: p.x, y: p.y },
        data: { text: cleanText(g.text), suspended: isSuspended(g.text), s: p.s, onAdopt: adoptGhost },
      };
    });
    const noteNodes: CanvasNode[] = layout.notes.map((nt) => ({
      id: nt.id, type: 'note' as const, position: { x: nt.x, y: nt.y },
      data: { text: nt.text, s: nt.s ?? 1, onText: noteText, onRemove: noteRemove },
    }));
    setNodes([...intentNodes, ...ghostNodes, ...noteNodes]);

    const known = new Set(union.map((u) => u.id));
    const birth: Edge[] = tree.nodes
      .filter((n) => n.parent !== null)
      .map((n) => ({
        id: `b-${n.id}`, source: n.parent as string, target: n.id,
        markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.6 },
      }));
    const ghostEdges: Edge[] = proposals
      .map((g): Edge | null => {
        const src = g.parent !== null ? (adoptedByProposal.get(g.parent) ?? g.parent) : null;
        return src !== null && known.has(src)
          ? { id: `g-${g.id}`, source: src, target: g.id, style: { strokeDasharray: '4 5', opacity: 0.45 } }
          : null;
      })
      .filter((e): e is Edge => e !== null);
    const seen = new Set<string>();
    const merged: Edge[] = [];
    for (const n of tree.nodes) {
      for (const m of n.mergedWith) {
        const key = n.id < m ? `${n.id}|${m}` : `${m}|${n.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({
          id: `m-${key}`, source: n.id < m ? n.id : m, target: n.id < m ? m : n.id,
          style: { strokeDasharray: '6 4', opacity: 0.7 }, label: '一件事',
        });
      }
    }
    setEdges([...birth, ...ghostEdges, ...merged]);
  }, [tree, proposals, layout, noteText, noteRemove, adoptGhost, setNodes]);

  // 拖完，位置归档（保留尺度）——这是画布唯一"写"的东西之一。
  const onDragStop: OnNodeDrag<CanvasNode> = useCallback((_e, node) => {
    if (node.type === 'note') {
      mutateLayout((l) => ({
        ...l,
        notes: l.notes.map((n) => (n.id === node.id ? { ...n, x: node.position.x, y: node.position.y } : n)),
      }));
    } else {
      mutateLayout((l) => {
        const prev = l.positions[node.id];
        return {
          ...l,
          positions: {
            ...l.positions,
            [node.id]: {
              x: node.position.x, y: node.position.y,
              ...(prev?.s !== undefined ? { s: prev.s } : {}),
            },
          },
        };
      });
    }
  }, [mutateLayout]);

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback((_e, node) => {
    setSelectedId(node.type === 'intent' ? node.id : null);
    setWhyText('');
  }, []);

  const addNoteAt = useCallback((x: number, y: number) => {
    const p = screenToFlowPosition({ x, y });
    const s = clampScale(1 / getViewport().zoom);
    mutateLayout((l) => ({
      ...l,
      notes: [...l.notes, { id: crypto.randomUUID(), x: p.x, y: p.y, s, text: '' }],
    }));
  }, [mutateLayout, screenToFlowPosition, getViewport]);

  /** 顶栏认领：落在视野中心，尺度=当下的缩放层面。 */
  const adoptHere = useCallback(async (text: string) => {
    const s = clampScale(1 / getViewport().zoom);
    const c = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight * 0.45 });
    try {
      const { id } = await act('adopt', { text });
      mutateLayout((l) => ({
        ...l,
        positions: { ...l.positions, [id]: { x: c.x, y: c.y, ...(s !== 1 ? { s } : {}) } },
      }));
      await reload();
    } catch (e) { oops(e); }
  }, [getViewport, screenToFlowPosition, mutateLayout, reload]);

  const doAct = async (kind: 'resume' | 'done' | 'drop', params: { target?: string; why?: string }) => {
    try {
      await act(kind, params);
      await reload();
    } catch (e) { oops(e); }
  };

  const selected: TreeNode | null = tree?.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="app" onDoubleClick={(e) => {
      if ((e.target as HTMLElement).classList.contains('react-flow__pane')) addNoteAt(e.clientX, e.clientY);
    }}>
      <header>
        <span className="brand">Theseus · 画布</span>
        <span className="line" title="从当前沿出生边走到根">{tree?.line ?? '…'}</span>
        <span className="ghost-count dim">
          {proposals.length > 0 ? `幽灵 ${proposals.length} 条待认领` : ''}
        </span>
        <form className="say" onSubmit={(e) => {
          e.preventDefault();
          const text = sayText.trim();
          if (text === '') return;
          setSayText('');
          void adoptHere(text);
        }}>
          <input
            value={sayText}
            onChange={(e) => setSayText(e.target.value)}
            placeholder="说一句，认领一条意图（挂在当前之下，落在视野中心）…"
          />
          <button type="submit">认领</button>
        </form>
      </header>

      <div className="stage">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onDragStop}
          onNodeClick={onNodeClick}
          onPaneClick={() => setSelectedId(null)}
          zoomOnDoubleClick={false}
          fitView
          minZoom={0.05}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls />
          <MiniMap pannable zoomable nodeColor={(n) =>
            n.type === 'note' ? '#d9c26a' : n.type === 'ghost' ? '#565a63' : '#7a9ec9'
          } />
        </ReactFlow>

        {tree !== null && tree.nodes.length === 0 && proposals.length === 0 && (
          <div className="empty">
            <p>树还是空的。</p>
            <p>在上面说一句——比如「把画布做出来」——认领你的第一条意图。</p>
            <p className="dim">双击空白处可以贴一张便签（便签只活在布局里，不进痕迹）。</p>
          </div>
        )}

        {selected !== null && (
          <aside className="panel">
            <div className="p-saying">{selected.saying}</div>
            <div className="p-row">
              状态：{selected.status === 'open' ? '悬着' : selected.status === 'done' ? '做完了' : '不做了'}
              {tree?.current === selected.id ? '（当前）' : ''}
            </div>
            {selected.bornOf !== null && (
              <div className="p-born">
                <div className="dim">出生的那句话（{selected.bornOf.ts.slice(0, 16).replace('T', ' ')}）：</div>
                <blockquote>{selected.bornOf.text}</blockquote>
              </div>
            )}
            {selected.mergedWith.length > 0 && (
              <div className="p-row dim">已与 {selected.mergedWith.length} 条并为一件事</div>
            )}
            <div className="p-actions">
              <button onClick={() => void doAct('resume', { target: selected.id })}>回到这儿</button>
              <button onClick={() => void doAct('done', { target: selected.id })}>做完了</button>
            </div>
            <div className="p-drop">
              <input
                value={whyText}
                onChange={(e) => setWhyText(e.target.value)}
                placeholder="不做了？先写一句为什么…"
              />
              <button
                disabled={whyText.trim() === ''}
                onClick={() => { void doAct('drop', { target: selected.id, why: whyText.trim() }); setWhyText(''); }}
              >不做了</button>
            </div>
            <button className="p-close" onClick={() => setSelectedId(null)}>关</button>
          </aside>
        )}

        {err !== '' && <div className="toast">{err}</div>}
      </div>
    </div>
  );
}
