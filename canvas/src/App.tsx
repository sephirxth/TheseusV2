import {
  Background, Controls, MiniMap, Panel, ReactFlow, useNodesState, useReactFlow, useViewport,
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

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;

/** 层级条：全景 + 四个常驻层（数字键 0–4 直达），顺带显示现在在第几层。 */
const LAYERS: { key: string; label: string; zoom: number }[] = [
  { key: '1', label: '大局 0.1×', zoom: 0.1 },
  { key: '2', label: '中景 0.3×', zoom: 0.3 },
  { key: '3', label: '阅读 1×', zoom: 1 },
  { key: '4', label: '细节 2×', zoom: 2 },
];

function LayerBar() {
  const { zoom } = useViewport();
  const { zoomTo, fitView } = useReactFlow();
  return (
    <Panel position="bottom-center" className="layerbar">
      <button title="快捷键 0" onClick={() => void fitView({ duration: 350, padding: 0.15 })}>全景</button>
      {LAYERS.map((l) => (
        <button
          key={l.key}
          title={`快捷键 ${l.key}`}
          className={Math.abs(zoom - l.zoom) / l.zoom < 0.25 ? 'here' : ''}
          onClick={() => void zoomTo(l.zoom, { duration: 300 })}
        >{l.label}</button>
      ))}
      <span className="zoom-now">{zoom >= 1 ? `${zoom.toFixed(1)}×` : `${(zoom * 100).toFixed(0)}%`}</span>
    </Panel>
  );
}

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
  /** 布局的唯一真身。state 只负责触发重画；存盘、视口、冲刷都走这个 ref。 */
  const layoutRef = useRef<Layout | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialViewDone = useRef(false);
  /** 本次渲染里每个东西实际落在哪（含自动摆位的），认领实体化/手调大小按这个原位落地。 */
  const posRef = useRef<Record<string, { x: number; y: number; s: number }>>({});
  const kindRef = useRef<Record<string, 'intent' | 'ghost' | 'note'>>({});
  const stageRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition, getViewport, setViewport, setCenter, zoomTo, fitView } = useReactFlow();

  // 数字键直达层级：0 全景，1–4 对应层级条。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t !== null && t.closest('textarea, input, select') !== null) return;
      if (e.key === '0') { void fitView({ duration: 350, padding: 0.15 }); return; }
      const hit = LAYERS.find((l) => l.key === e.key);
      if (hit !== undefined) void zoomTo(hit.zoom, { duration: 300 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitView, zoomTo]);

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
        layoutRef.current = l;
        setTree(t); setProposals(p); setLayout(l);
      } catch (e) { oops(e); }
    })();
    return onChange(() => { void reload(); });
  }, [reload]);

  /** 布局自动保存：每次改动 400ms 后落盘；页面要走时立刻冲刷（keepalive），不丢最后一手。 */
  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (layoutRef.current !== null) saveLayout(layoutRef.current).catch(oops);
    }, 400);
  }, []);

  useEffect(() => {
    const flush = () => {
      if (saveTimer.current === null || layoutRef.current === null) return;
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      void fetch('/api/layout', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(layoutRef.current), keepalive: true,
      });
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  const mutateLayout = useCallback((fn: (l: Layout) => Layout) => {
    if (layoutRef.current === null) return;
    layoutRef.current = fn(layoutRef.current);
    setLayout(layoutRef.current);
    scheduleSave();
  }, [scheduleSave]);

  /** 手调大小：s 也是布局（"字号表意"的另一半——事后还能改）。 */
  const scaleNode = useCallback((id: string, s: number) => {
    if (kindRef.current[id] === 'note') {
      mutateLayout((l) => ({ ...l, notes: l.notes.map((n) => (n.id === id ? { ...n, s } : n)) }));
    } else {
      const p = posRef.current[id] ?? { x: 0, y: 0, s: 1 };
      mutateLayout((l) => ({ ...l, positions: { ...l.positions, [id]: { x: p.x, y: p.y, s } } }));
    }
  }, [mutateLayout]);

  // 滚轮提速：每格约 ×1.5（两格翻倍），指向光标缩放；Alt 精调；触控板捏合走同一条路。
  // 默认的滚轮步长跨 0.05×→1× 要几十格——层与层离得远，步子必须大。
  useEffect(() => {
    const el = stageRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (t !== null && t.closest('.panel, .layerbar, textarea, input, select') !== null) return;
      e.preventDefault();
      e.stopPropagation();
      // Shift+滚轮悬停在节点上 = 调这个节点的大小（布局的一部分），不动镜头。
      if (e.shiftKey && t !== null) {
        const nodeEl = t.closest('.react-flow__node');
        const id = nodeEl instanceof HTMLElement ? nodeEl.getAttribute('data-id') : null;
        if (id !== null && id !== '') {
          const dyn = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
          const s0 = posRef.current[id]?.s ?? 1;
          scaleNode(id, Math.min(10, Math.max(0.35, s0 * Math.exp(-dyn * 0.0015))));
          return;
        }
      }
      const dy = (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * (e.ctrlKey ? 3 : 1);
      const speed = e.altKey ? 0.001 : 0.004;
      const vp = getViewport();
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * Math.exp(-dy * speed)));
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const fx = (px - vp.x) / vp.zoom;
      const fy = (py - vp.y) / vp.zoom;
      void setViewport({ x: px - fx * z, y: py - fy * z, zoom: z });
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, [getViewport, setViewport, scaleNode]);

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
    const kmap: Record<string, 'intent' | 'ghost' | 'note'> = {};
    for (const u of union) pmap[u.id] = at(u.id);
    for (const n of tree.nodes) kmap[n.id] = 'intent';
    for (const g of proposals) kmap[g.id] = 'ghost';
    for (const nt of layout.notes) {
      kmap[nt.id] = 'note';
      pmap[nt.id] = { x: nt.x, y: nt.y, s: nt.s ?? 1 };
    }
    posRef.current = pmap;
    kindRef.current = kmap;

    const intentNodes: CanvasNode[] = tree.nodes.map((n) => {
      const p = at(n.id);
      return {
        id: n.id, type: 'intent' as const, position: { x: p.x, y: p.y },
        data: {
          saying: n.saying, status: n.status, isCurrent: tree.current === n.id,
          mergedCount: n.mergedWith.length, bornText: n.bornOf?.text ?? '', s: p.s,
          onScale: scaleNode,
        },
      };
    });
    const ghostNodes: CanvasNode[] = proposals.map((g) => {
      const p = at(g.id);
      return {
        id: g.id, type: 'ghost' as const, position: { x: p.x, y: p.y },
        data: {
          text: cleanText(g.text), suspended: isSuspended(g.text), s: p.s,
          onAdopt: adoptGhost, onScale: scaleNode,
        },
      };
    });
    const noteNodes: CanvasNode[] = layout.notes.map((nt) => ({
      id: nt.id, type: 'note' as const, position: { x: nt.x, y: nt.y },
      data: { text: nt.text, s: nt.s ?? 1, onText: noteText, onRemove: noteRemove, onScale: scaleNode },
    }));
    setNodes([...intentNodes, ...ghostNodes, ...noteNodes]);

    // 开场视口：上次离开在哪儿，这次就在哪儿（视口也是布局）；从没存过才 fitView。
    if (!initialViewDone.current) {
      initialViewDone.current = true;
      const vp = layout.viewport;
      setTimeout(() => {
        if (vp !== undefined) void setViewport(vp);
        else void fitView({ padding: 0.15 });
      }, 80);
    }

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
  }, [tree, proposals, layout, noteText, noteRemove, adoptGhost, scaleNode, setNodes, setViewport, fitView]);

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

  /** 双击一个东西 = 跳到它的层级：缩放到 1/s（它的字回到基准大小）并居中。 */
  const onNodeDoubleClick: NodeMouseHandler<CanvasNode> = useCallback((_e, node) => {
    const s = 's' in node.data ? node.data.s : 1;
    const w = node.measured?.width ?? 200;
    const h = node.measured?.height ?? 80;
    void setCenter(node.position.x + w / 2, node.position.y + h / 2, {
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, 1 / s)),
      duration: 350,
    });
  }, [setCenter]);

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

      <div className="stage" ref={stageRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onDragStop}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onPaneClick={() => setSelectedId(null)}
          onMoveEnd={(_e, vp) => {
            if (layoutRef.current === null || !initialViewDone.current) return;
            layoutRef.current = { ...layoutRef.current, viewport: vp };
            scheduleSave();
          }}
          zoomOnDoubleClick={false}
          zoomOnScroll={false}
          panOnScroll={false}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls />
          <MiniMap pannable zoomable nodeColor={(n) =>
            n.type === 'note' ? '#d9c26a' : n.type === 'ghost' ? '#565a63' : '#7a9ec9'
          } />
          <LayerBar />
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
