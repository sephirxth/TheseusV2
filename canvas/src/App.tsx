import {
  Background, ConnectionMode, Controls, MiniMap, Panel, ReactFlow, ViewportPortal,
  useEdgesState, useNodesState, useReactFlow, useViewport,
  MarkerType, type Connection, type Edge, type NodeMouseHandler, type OnNodeDrag,
} from '@xyflow/react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
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
/** World scale at creation = 1 / zoom at that moment, clamped to readable range. */
const clampScale = (v: number): number => Math.min(10, Math.max(0.35, v));

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;

const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Timeline projection axis: date ticks at the bottom + one swimlane guide per intent line. */
interface AxisData {
  x0: number;
  width: number;
  top: number;
  axisY: number;
  ticks: { x: number; label: string }[];
  lanes: { y: number; label: string }[];
}

/** Level bar: overview + four persistent levels (keys 0-4 jump directly), also shows the current level. */
const LAYERS: { key: string; label: string; zoom: number }[] = [
  { key: '1', label: 'overview 0.1x', zoom: 0.1 },
  { key: '2', label: 'mid 0.3x', zoom: 0.3 },
  { key: '3', label: 'read 1x', zoom: 1 },
  { key: '4', label: 'detail 2x', zoom: 2 },
];

function LayerBar() {
  const { zoom } = useViewport();
  const { zoomTo, fitView } = useReactFlow();
  return (
    <Panel position="bottom-center" className="layerbar">
      <button title="hotkey 0" onClick={() => void fitView({ duration: 350, padding: 0.15 })}>overview</button>
      {LAYERS.map((l) => (
        <button
          key={l.key}
          title={`hotkey ${l.key}`}
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
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sayText, setSayText] = useState('');
  const [whyText, setWhyText] = useState('');
  const [err, setErr] = useState('');
  /** View projection: free layout (human-placed) / timeline (time on x, intent lines on y, computed). */
  const [mode, setMode] = useState<'free' | 'timeline'>('free');
  const [axis, setAxis] = useState<AxisData | null>(null);
  /** A line dragged between two real intents: ask whether it is a merge or just related. */
  const [pendingConnect, setPendingConnect] = useState<{ a: string; b: string } | null>(null);
  const [mergeWhy, setMergeWhy] = useState('');
  /** The single source of truth for layout. State only triggers repaint; persistence, viewport, flushing all go through this ref. */
  const layoutRef = useRef<Layout | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialViewDone = useRef(false);
  /** Where each thing actually landed in this render (including auto-placed); claim materialization and manual resize land in-place by this. */
  const posRef = useRef<Record<string, { x: number; y: number; s: number }>>({});
  const kindRef = useRef<Record<string, 'intent' | 'ghost' | 'note'>>({});
  const stageRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition, getViewport, setViewport, setCenter, zoomTo, fitView } = useReactFlow();

  // A small handle for automated verification (headless browser viewport control); not part of any business logic.
  useEffect(() => {
    (window as unknown as Record<string, unknown>)['__canvas'] = { setCenter, zoomTo, fitView, getViewport };
  }, [setCenter, zoomTo, fitView, getViewport]);

  // Number keys jump to levels: 0 overview, 1-4 match the level bar.
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

  // On load: tree, proposals, layout; then listen — refetch when the server says something changed.
  useEffect(() => {
    void (async () => {
      try {
        const [t, p, l] = await Promise.all([fetchTree(), fetchProposals(), fetchLayout()]);
        layoutRef.current = l;
        setTree(t); setProposals(p); setLayout(l);
        if (l.mode !== undefined) setMode(l.mode);
      } catch (e) { oops(e); }
    })();
    return onChange(() => { void reload(); });
  }, [reload]);

  /** Layout autosave: persist 400ms after each change; flush immediately on unload (keepalive), never lose the last move. */
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

  /** Manual resize: s is also layout (the other half of size-as-semantics — adjustable afterwards). */
  const scaleNode = useCallback((id: string, s: number) => {
    if (kindRef.current[id] === 'note') {
      mutateLayout((l) => ({ ...l, notes: l.notes.map((n) => (n.id === id ? { ...n, s } : n)) }));
    } else {
      const p = posRef.current[id] ?? { x: 0, y: 0, s: 1 };
      mutateLayout((l) => ({ ...l, positions: { ...l.positions, [id]: { x: p.x, y: p.y, s } } }));
    }
  }, [mutateLayout]);

  // Wheel acceleration: ~x1.5 per tick (double in two ticks), cursor-anchored zoom; Alt for fine control; trackpad pinch goes through the same path.
  // Default wheel step needs dozens of ticks from 0.05x to 1x — levels are far apart, steps must be large.
  useEffect(() => {
    const el = stageRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (t !== null && t.closest('.panel, .layerbar, textarea, input, select') !== null) return;
      e.preventDefault();
      e.stopPropagation();
      // Shift+wheel hovering a node = resize that node (part of layout), camera untouched.
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
    mutateLayout((l) => ({
      ...l,
      notes: l.notes.filter((n) => n.id !== id),
      links: (l.links ?? []).filter((k) => k.from !== id && k.to !== id),
    }));
  }, [mutateLayout]);

  /** Switch projection and remember: same truth, two organizations. */
  const switchMode = useCallback((m: 'free' | 'timeline') => {
    setMode(m);
    mutateLayout((l) => ({ ...l, mode: m }));
    setTimeout(() => { void fitView({ padding: 0.15, duration: 350 }); }, 120);
  }, [mutateLayout, fitView]);

  /** Native link: human-drawn relation annotation, stored in layout, deletable. */
  const addLink = useCallback((from: string, to: string) => {
    mutateLayout((l) => {
      const links = l.links ?? [];
      if (links.some((k) => (k.from === from && k.to === to) || (k.from === to && k.to === from))) return l;
      return { ...l, links: [...links, { id: crypto.randomUUID(), from, to }] };
    });
  }, [mutateLayout]);

  /** Line drag: both ends real intents -> ask merge-or-related; touching a note/ghost -> a plain annotation line. */
  const onConnect = useCallback((c: Connection) => {
    if (c.source === null || c.target === null || c.source === c.target) return;
    if (kindRef.current[c.source] === 'intent' && kindRef.current[c.target] === 'intent') {
      setMergeWhy('');
      setPendingConnect({ a: c.source, b: c.target });
    } else {
      addLink(c.source, c.target);
    }
  }, [addLink]);

  /** Ghost materialization: acceptance = a true utterance through the human gate; if an accepted ancestor exists, first resume under it, then accept. */
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
        // Annotation lines on a ghost follow the materialized node; no broken lines.
        links: (l.links ?? []).map((k) => ({
          ...k,
          from: k.from === pid ? newId : k.from,
          to: k.to === pid ? newId : k.to,
        })),
      }));
      await reload();
    } catch (e) { oops(e); }
  }, [tree, proposals, mutateLayout, reload]);

  // Tree (mirrors) + proposals (ghosts) + notes (native) -> canvas. Positions: human-placed where placed, initial values otherwise.
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

    // Timeline projection: x = real time (date ticks at the bottom), y = intent lines (one swimlane per root,
    // notes on a bottom lane). The projection is a computed view; it never moves human-placed positions in free layout.
    const unionById = new Map(union.map((u) => [u.id, u]));
    const timeOf = (id: string): number => {
      const k0 = tree.nodes.find((n) => n.id === id);
      if (k0 !== undefined) return Date.parse(k0.bornOf?.ts ?? k0.lastTouched);
      const g = proposals.find((p) => p.id === id);
      if (g !== undefined) return Date.parse(g.at ?? g.ts);   // ghosts prefer the registration date of the thing they refer to
      const nt = layout.notes.find((n) => n.id === id);
      return nt?.t ?? Date.now();
    };
    const laneRootOf = (id: string): string => {
      let cur = id;
      for (let i = 0; i < 64; i++) {
        const p = unionById.get(cur)?.parent;
        if (p === undefined || p === null || !unionById.has(p)) break;
        cur = p;
      }
      return cur;
    };
    const labelOf = (id: string): string => {
      const n = tree.nodes.find((x) => x.id === id);
      const raw = n !== undefined ? n.saying : cleanText(proposals.find((p) => p.id === id)?.text ?? id);
      return raw.length > 14 ? `${raw.slice(0, 14)}…` : raw;
    };
    const timeline: Record<string, { x: number; y: number }> = {};
    let axisData: AxisData | null = null;
    if (mode === 'timeline') {
      const allIds = [...union.map((u) => u.id), ...layout.notes.map((n) => n.id)];
      const times = new Map(allIds.map((id) => [id, timeOf(id)]));
      const roots = [...new Set(union.map((u) => laneRootOf(u.id)))]
        .sort((a, b) => (times.get(a) ?? 0) - (times.get(b) ?? 0));
      const laneIdx = new Map(roots.map((r, i) => [r, i]));
      const noteLane = roots.length;
      const laneOf = (id: string): number =>
        unionById.has(id) ? (laneIdx.get(laneRootOf(id)) ?? noteLane) : noteLane;

      const tsAll = [...times.values()];
      const minT = Math.min(...tsAll);
      const maxT = Math.max(...tsAll);
      const days = Math.max(1, (maxT - minT) / 86_400_000);
      const pxPerDay = Math.max(24, Math.min(260, 9000 / days));
      const X0 = 120;
      const rawX = (t: number): number => X0 + ((t - minT) / 86_400_000) * pxPerDay;
      const LANE_H = 170;

      // sorted by time within a swimlane; same-day items step right (order kept, no stacking)
      const byLane = new Map<number, string[]>();
      for (const id of allIds) {
        const l = laneOf(id);
        const list = byLane.get(l) ?? [];
        list.push(id);
        byLane.set(l, list);
      }
      let maxX = X0;
      for (const [lane, ids] of byLane) {
        ids.sort((a, b) => ((times.get(a) ?? 0) - (times.get(b) ?? 0)) || (a < b ? -1 : 1));
        let prev = -Infinity;
        for (const id of ids) {
          const x = Math.max(rawX(times.get(id) ?? minT), prev + 250);
          prev = x;
          timeline[id] = { x, y: 80 + lane * LANE_H };
          if (x > maxX) maxX = x;
        }
      }

      // bottom timeline: step chosen by span (1/2/7/14/30 days), year shown on first tick and at year boundaries
      const laneCount = roots.length + (byLane.has(noteLane) ? 1 : 0);
      const axisY = 80 + laneCount * LANE_H + 20;
      const stepDays = days <= 16 ? 1 : days <= 32 ? 2 : days <= 112 ? 7 : days <= 224 ? 14 : 30;
      const ticks: { x: number; label: string }[] = [];
      const d0 = new Date(minT);
      d0.setHours(0, 0, 0, 0);
      let lastYear = '';
      for (let t = d0.getTime(); t <= maxT + stepDays * 86_400_000; t += stepDays * 86_400_000) {
        const d = new Date(t);
        const yr = String(d.getFullYear());
        const label = `${yr !== lastYear ? `${yr}-` : ''}${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        lastYear = yr;
        ticks.push({ x: rawX(t), label });
      }
      const lanes = roots.map((r, i) => ({ y: 80 + i * LANE_H + 34, label: labelOf(r) }));
      if (byLane.has(noteLane)) lanes.push({ y: 80 + noteLane * LANE_H + 34, label: 'notes' });
      const lastTickX = ticks[ticks.length - 1]?.x ?? maxX;
      axisData = {
        x0: X0 - 60, top: 30, axisY, ticks, lanes,
        width: Math.max(maxX, lastTickX) - (X0 - 60) + 240,
      };
    }
    setAxis(axisData);

    const at = (id: string): { x: number; y: number; s: number } => {
      const stored = layout.positions[id];
      const proj = timeline[id];
      const base = proj ?? stored ?? auto[id] ?? { x: 0, y: 0 };
      return { x: base.x, y: base.y, s: stored?.s ?? 1 };
    };
    const dateOf = mode === 'timeline'
      ? (id: string): string => fmtDate(timeOf(id))
      : (): undefined => undefined;
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
      const date = dateOf(n.id);
      return {
        id: n.id, type: 'intent' as const, position: { x: p.x, y: p.y },
        data: {
          saying: n.saying, status: n.status, isCurrent: tree.current === n.id,
          mergedCount: n.mergedWith.length, bornText: n.bornOf?.text ?? '', s: p.s,
          ...(date !== undefined ? { date } : {}),
          onScale: scaleNode,
        },
      };
    });
    const ghostNodes: CanvasNode[] = proposals.map((g) => {
      const p = at(g.id);
      const date = dateOf(g.id);
      return {
        id: g.id, type: 'ghost' as const, position: { x: p.x, y: p.y },
        data: {
          text: cleanText(g.text), suspended: isSuspended(g.text), s: p.s,
          ...(date !== undefined ? { date } : {}),
          onAdopt: adoptGhost, onScale: scaleNode,
        },
      };
    });
    const noteNodes: CanvasNode[] = layout.notes.map((nt) => {
      const p = at(nt.id);
      const date = dateOf(nt.id);
      return {
        id: nt.id, type: 'note' as const,
        position: mode === 'timeline' ? { x: p.x, y: p.y } : { x: nt.x, y: nt.y },
        data: {
          text: nt.text, s: nt.s ?? 1,
          ...(date !== undefined ? { date } : {}),
          onText: noteText, onRemove: noteRemove, onScale: scaleNode,
        },
      };
    });
    setNodes([...intentNodes, ...ghostNodes, ...noteNodes]);

    // Opening viewport: wherever you left off last time (viewport is layout too); fitView only if nothing stored.
    if (!initialViewDone.current) {
      initialViewDone.current = true;
      const vp = layout.viewport;
      setTimeout(() => {
        if (vp !== undefined) void setViewport(vp);
        else void fitView({ padding: 0.15 });
      }, 80);
    }

    const known = new Set([...union.map((u) => u.id), ...layout.notes.map((n) => n.id)]);
    // Native link: human-drawn annotation, yellow dotted line, deletable.
    const linkEdges: Edge[] = (layout.links ?? [])
      .filter((k) => known.has(k.from) && known.has(k.to))
      .map((k) => ({
        id: `l-${k.id}`, source: k.from, target: k.to,
        style: { stroke: '#d9c26a', strokeDasharray: '2 6', strokeWidth: 1.6, opacity: 0.85 },
        ...(k.label !== undefined ? { label: k.label } : {}),
      }));
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
          style: { strokeDasharray: '6 4', opacity: 0.7 }, label: 'same thing',
        });
      }
    }
    setEdges([...birth, ...ghostEdges, ...merged, ...linkEdges]);
  }, [tree, proposals, layout, mode, noteText, noteRemove, adoptGhost, scaleNode, setNodes, setViewport, fitView]);

  // After drag, position is archived (scale preserved) — one of the few things the canvas writes.
  // Timeline is a projection (positions computed), never persisted.
  const onDragStop: OnNodeDrag<CanvasNode> = useCallback((_e, node) => {
    if (mode !== 'free') return;
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
  }, [mutateLayout, mode]);

  /** Delete key: only native things can be deleted. Birth/merge edges are projections of traces; intents are not deletable by key. */
  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    const native = deleted.filter((e) => e.id.startsWith('l-')).map((e) => e.id.slice(2));
    if (native.length > 0) {
      mutateLayout((l) => ({ ...l, links: (l.links ?? []).filter((k) => !native.includes(k.id)) }));
    }
    if (deleted.some((e) => !e.id.startsWith('l-'))) {
      oops('birth/merge edges are trace projections, cannot be deleted on the canvas');
      void reload();                       // immediately restore the truth edge that was visually removed
    }
  }, [mutateLayout, reload]);

  const onNodesDelete = useCallback((deleted: CanvasNode[]) => {
    const notes = deleted.filter((n) => n.type === 'note').map((n) => n.id);
    for (const id of notes) noteRemove(id);
    if (deleted.some((n) => n.type === 'intent')) {
      oops('intents cannot be deleted by key — use drop, the reason goes into traces');
    }
  }, [noteRemove]);

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback((_e, node) => {
    setSelectedId(node.type === 'intent' ? node.id : null);
    setWhyText('');
  }, []);

  /** Double-click a thing = jump to its level: zoom to 1/s (its text returns to base size) and center. */
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
      notes: [...l.notes, { id: crypto.randomUUID(), x: p.x, y: p.y, s, t: Date.now(), text: '' }],
    }));
  }, [mutateLayout, screenToFlowPosition, getViewport]);

  /** Top-bar claim: lands at view center, scale = current zoom level. */
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
        <span className="brand">Theseus · Canvas</span>
        <span className="line" title="walk from current to root along birth edges">{tree?.line ?? '…'}</span>
        <span className="ghost-count dim">
          {proposals.length > 0 ? `${proposals.length} ghost proposal${proposals.length > 1 ? 's' : ''} awaiting acceptance` : ''}
        </span>
        <span className="mode-toggle">
          <button className={mode === 'free' ? 'here' : ''} onClick={() => switchMode('free')}>free</button>
          <button className={mode === 'timeline' ? 'here' : ''} onClick={() => switchMode('timeline')}>timeline</button>
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
            placeholder="say something to claim an intent (child of current, lands at view center)..."
          />
          <button type="submit">claim</button>
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
          onConnect={onConnect}
          onEdgesChange={onEdgesChange}
          onEdgesDelete={onEdgesDelete}
          onNodesDelete={onNodesDelete}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={['Backspace', 'Delete']}
          nodesDraggable={mode === 'free'}
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
          {mode === 'timeline' && axis !== null && (
            <ViewportPortal>
              <div
                className="tl-axisline"
                style={{ transform: `translate(${axis.x0}px, ${axis.axisY}px)`, width: axis.width }}
              />
              {axis.ticks.map((t, i) => (
                <Fragment key={`t${i}`}>
                  <div
                    className="tl-grid"
                    style={{ transform: `translate(${t.x}px, ${axis.top}px)`, height: axis.axisY - axis.top }}
                  />
                  <div className="tl-ticklabel" style={{ transform: `translate(${t.x - 36}px, ${axis.axisY + 12}px)` }}>
                    {t.label}
                  </div>
                </Fragment>
              ))}
              {axis.lanes.map((l, i) => (
                <Fragment key={`n${i}`}>
                  <div
                    className="tl-lane-line"
                    style={{ transform: `translate(${axis.x0}px, ${l.y}px)`, width: axis.width }}
                  />
                  <div className="tl-lane-label" style={{ transform: `translate(${axis.x0}px, ${l.y - 44}px)` }}>
                    {l.label}
                  </div>
                </Fragment>
              ))}
            </ViewportPortal>
          )}
        </ReactFlow>

        {tree !== null && tree.nodes.length === 0 && proposals.length === 0 && (
          <div className="empty">
            <p>The tree is empty.</p>
            <p>Say something above — e.g. “build the canvas” — to claim your first intent.</p>
            <p className="dim">Double-click empty space to pin a note (notes live in layout only, never in traces).</p>
          </div>
        )}

        {selected !== null && (
          <aside className="panel">
            <div className="p-saying">{selected.saying}</div>
            <div className="p-row">
              status: {selected.status === 'open' ? 'open' : selected.status === 'done' ? 'done' : 'dropped'}
              {tree?.current === selected.id ? '(current)' : ''}
            </div>
            {selected.bornOf !== null && (
              <div className="p-born">
                <div className="dim">The utterance it was born of ({selected.bornOf.ts.slice(0, 16).replace('T', ' ')}）：</div>
                <blockquote>{selected.bornOf.text}</blockquote>
              </div>
            )}
            {selected.mergedWith.length > 0 && (
              <div className="p-row dim">merged with {selected.mergedWith.length} other intent(s)</div>
            )}
            <div className="p-actions">
              <button onClick={() => void doAct('resume', { target: selected.id })}>resume here</button>
              <button onClick={() => void doAct('done', { target: selected.id })}>mark done</button>
            </div>
            <div className="p-drop">
              <input
                value={whyText}
                onChange={(e) => setWhyText(e.target.value)}
                placeholder="dropping it? say why first..."
              />
              <button
                disabled={whyText.trim() === ''}
                onClick={() => { void doAct('drop', { target: selected.id, why: whyText.trim() }); setWhyText(''); }}
              >drop</button>
            </div>
            <button className="p-close" onClick={() => setSelectedId(null)}>close</button>
          </aside>
        )}

        {pendingConnect !== null && (
          <div className="connect-ask">
            <div className="ca-title">
              Connect “{tree?.nodes.find((n) => n.id === pendingConnect.a)?.saying ?? '...'}”
              and “{tree?.nodes.find((n) => n.id === pendingConnect.b)?.saying ?? '...'}” —
            </div>
            <input
              value={mergeWhy}
              onChange={(e) => setMergeWhy(e.target.value)}
              placeholder="if merging, say why they are one thing (optional)..."
            />
            <div className="ca-actions">
              <button onClick={() => {
                const { a, b } = pendingConnect;
                setPendingConnect(null);
                void (async () => {
                  try {
                    await act('merge', { a, b, ...(mergeWhy.trim() !== '' ? { why: mergeWhy.trim() } : {}) });
                    await reload();
                  } catch (e) { oops(e); }
                })();
              }}>same thing (merge, into traces)</button>
              <button onClick={() => { addLink(pendingConnect.a, pendingConnect.b); setPendingConnect(null); }}>
                just related (draw a link, layout only)
              </button>
              <button className="ca-cancel" onClick={() => setPendingConnect(null)}>cancel</button>
            </div>
          </div>
        )}

        {err !== '' && <div className="toast">{err}</div>}
      </div>
    </div>
  );
}
