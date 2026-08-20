import {
  Background, Controls, MiniMap, ReactFlow, useNodesState, useReactFlow,
  MarkerType, type Edge, type NodeMouseHandler, type OnNodeDrag,
} from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { act, fetchLayout, fetchTree, onChange, saveLayout } from './api';
import type { Layout, TreeData, TreeNode } from './api';
import { autoPlace } from './layout';
import { IntentNodeView, NoteNodeView, type IntentFlowNode, type NoteFlowNode } from './nodes';

type CanvasNode = IntentFlowNode | NoteFlowNode;

const nodeTypes = { intent: IntentNodeView, note: NoteNodeView };

export default function App() {
  const [tree, setTree] = useState<TreeData | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sayText, setSayText] = useState('');
  const [whyText, setWhyText] = useState('');
  const [err, setErr] = useState('');
  const dirty = useRef(false);
  const { screenToFlowPosition } = useReactFlow();

  const oops = (e: unknown) => {
    setErr(e instanceof Error ? e.message : String(e));
    setTimeout(() => setErr(''), 5000);
  };

  const reloadTree = useCallback(async () => {
    try { setTree(await fetchTree()); } catch (e) { oops(e); }
  }, []);

  // 开场：取树、取布局，然后听着——服务端喊"变了"就再取一次树。
  useEffect(() => {
    void (async () => {
      try {
        const [t, l] = await Promise.all([fetchTree(), fetchLayout()]);
        setTree(t); setLayout(l);
      } catch (e) { oops(e); }
    })();
    return onChange(() => { void reloadTree(); });
  }, [reloadTree]);

  // 布局归人：改了就存（略作合并），存的只有位置和便签。
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

  // 树（镜像）+ 便签（原生）→ 画布上的节点。位置：人摆过的用人摆的，没摆过的给个初始值。
  useEffect(() => {
    if (tree === null || layout === null) return;
    const auto = autoPlace(tree.nodes, layout.positions);
    const at = (id: string) => layout.positions[id] ?? auto[id] ?? { x: 0, y: 0 };
    const intentNodes: CanvasNode[] = tree.nodes.map((n) => ({
      id: n.id, type: 'intent' as const, position: at(n.id),
      data: {
        saying: n.saying, status: n.status, isCurrent: tree.current === n.id,
        mergedCount: n.mergedWith.length, bornText: n.bornOf?.text ?? '',
      },
    }));
    const noteNodes: CanvasNode[] = layout.notes.map((nt) => ({
      id: nt.id, type: 'note' as const, position: { x: nt.x, y: nt.y },
      data: { text: nt.text, onText: noteText, onRemove: noteRemove },
    }));
    setNodes([...intentNodes, ...noteNodes]);

    const birth: Edge[] = tree.nodes
      .filter((n) => n.parent !== null)
      .map((n) => ({
        id: `b-${n.id}`, source: n.parent as string, target: n.id,
        markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.6 },
      }));
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
    setEdges([...birth, ...merged]);
  }, [tree, layout, noteText, noteRemove, setNodes]);

  // 拖完，位置归档——这是画布唯一"写"的东西之一。
  const onDragStop: OnNodeDrag<CanvasNode> = useCallback((_e, node) => {
    if (node.type === 'intent') {
      mutateLayout((l) => ({ ...l, positions: { ...l.positions, [node.id]: node.position } }));
    } else {
      mutateLayout((l) => ({
        ...l,
        notes: l.notes.map((n) => (n.id === node.id ? { ...n, x: node.position.x, y: node.position.y } : n)),
      }));
    }
  }, [mutateLayout]);

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback((_e, node) => {
    setSelectedId(node.type === 'intent' ? node.id : null);
    setWhyText('');
  }, []);

  const addNoteAt = useCallback((x: number, y: number) => {
    const p = screenToFlowPosition({ x, y });
    mutateLayout((l) => ({
      ...l,
      notes: [...l.notes, { id: crypto.randomUUID(), x: p.x, y: p.y, text: '' }],
    }));
  }, [mutateLayout, screenToFlowPosition]);

  const doAct = async (kind: 'adopt' | 'resume' | 'done' | 'drop', params: { text?: string; target?: string; why?: string }) => {
    try {
      await act(kind, params);
      await reloadTree();
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
        <form className="say" onSubmit={(e) => {
          e.preventDefault();
          const text = sayText.trim();
          if (text === '') return;
          setSayText('');
          void doAct('adopt', { text });
        }}>
          <input
            value={sayText}
            onChange={(e) => setSayText(e.target.value)}
            placeholder="说一句，认领一条意图（挂在当前之下）…"
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
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls />
          <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'note' ? '#d9c26a' : '#7a9ec9')} />
        </ReactFlow>

        {tree !== null && tree.nodes.length === 0 && (
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
