// 三类节点，组件表就是类型注册表：镜像（意图）、幽灵（提议）、原生（便签）。
// 尺度：字号 = 基准 × s，其余尺寸全用 em 跟着走。s 来自创建时的缩放层面，
// 也可以事后手调（右下角柄 / Shift+滚轮）——大小是人赋予的语义，布局的一部分。

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';

const clampS = (v: number): number => Math.min(10, Math.max(0.35, v));

/** 右下角柄：拖动改 s。拖中本地实时预览，松手才归档（onScale）。 */
function useScaleDrag(id: string, s: number, onScale: (id: string, s: number) => void) {
  const [live, setLive] = useState<number | null>(null);
  const start = useRef<{ x0: number; s0: number; w0: number } | null>(null);
  const liveRef = useRef<number | null>(null);
  const set = (v: number | null) => { liveRef.current = v; setLive(v); };

  const grip = {
    className: 'resize-grip nodrag',
    title: '拖动调大小（Shift+滚轮也行）',
    onPointerDown: (e: RPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      const nodeEl = e.currentTarget.closest('.react-flow__node');
      start.current = {
        x0: e.clientX, s0: s,
        w0: nodeEl instanceof HTMLElement ? nodeEl.getBoundingClientRect().width : 200,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: RPointerEvent<HTMLDivElement>) => {
      if (start.current === null) return;
      const { x0, s0, w0 } = start.current;
      const factor = Math.max(0.15, (w0 + (e.clientX - x0)) / w0);
      set(clampS(s0 * factor));
    },
    onPointerUp: (e: RPointerEvent<HTMLDivElement>) => {
      if (start.current === null) return;
      start.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      const v = liveRef.current;
      set(null);
      if (v !== null) onScale(id, v);
    },
  };
  return { scale: live ?? s, grip };
}

export type IntentFlowNode = Node<{
  saying: string;
  status: 'open' | 'done' | 'dropped';
  isCurrent: boolean;
  mergedCount: number;
  bornText: string;
  s: number;
  /** 时间属性（出生那句话的时刻）；时间轴投影下显示。 */
  date?: string;
  onScale: (id: string, s: number) => void;
}, 'intent'>;

/** 镜像节点：树上的一条意图。数据活在痕迹里，这儿只负责长得像它。 */
export function IntentNodeView({ id, data, selected }: NodeProps<IntentFlowNode>) {
  const { scale, grip } = useScaleDrag(id, data.s, data.onScale);
  return (
    <div
      className={`intent-node s-${data.status}${data.isCurrent ? ' current' : ''}${selected ? ' selected' : ''}`}
      style={{ fontSize: `${14 * scale}px` }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="saying">
        {data.status === 'done' ? '✓ ' : ''}{data.saying}
      </div>
      <div className="meta">
        {data.isCurrent ? <span className="tag-current">当前</span> : null}
        {data.status === 'dropped' ? <span className="tag-dropped">不做了</span> : null}
        {data.mergedCount > 0 ? <span className="tag-merged">已并 {data.mergedCount}</span> : null}
        {data.date !== undefined ? <span className="tag-date">{data.date}</span> : null}
      </div>
      <div {...grip} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export type GhostFlowNode = Node<{
  text: string;
  suspended: boolean;
  s: number;
  date?: string;
  onAdopt: (proposalId: string) => void;
  onScale: (id: string, s: number) => void;
}, 'ghost'>;

/** 幽灵节点：agent 提的，树上不算数。认了那一下才是授权，节点就在原位实体化。 */
export function GhostNodeView({ id, data }: NodeProps<GhostFlowNode>) {
  const { scale, grip } = useScaleDrag(id, data.s, data.onScale);
  return (
    <div className={`ghost-node${data.suspended ? ' suspended' : ''}`} style={{ fontSize: `${14 * scale}px` }}>
      <Handle type="target" position={Position.Left} />
      <div className="g-chip">
        [意图·猜的]{data.suspended ? ' ⏸' : ''}
        {data.date !== undefined ? <span className="tag-date">{data.date}</span> : null}
      </div>
      <div className="saying">{data.text}</div>
      <button className="g-adopt nodrag" onClick={() => data.onAdopt(id)}>认领</button>
      <div {...grip} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export type NoteFlowNode = Node<{
  text: string;
  s: number;
  date?: string;
  onText: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onScale: (id: string, s: number) => void;
}, 'note'>;

/** 原生节点：便签。它只活在布局里——画布坏了，丢的是它，不是任何事实。
 *  也有连接点：便签连到谁身上，是一条原生关联（批注），不是树的边。 */
export function NoteNodeView({ id, data }: NodeProps<NoteFlowNode>) {
  const { scale, grip } = useScaleDrag(id, data.s, data.onScale);
  return (
    <div className="note-node" style={{ fontSize: `${13 * scale}px` }}>
      <Handle type="target" position={Position.Left} />
      <button className="note-x nodrag" title="删掉这张便签" onClick={() => data.onRemove(id)}>×</button>
      <textarea
        className="nodrag"
        defaultValue={data.text}
        placeholder="写点什么…"
        onBlur={(e) => data.onText(id, e.target.value)}
      />
      {data.date !== undefined ? <div className="note-date">{data.date}</div> : null}
      <div {...grip} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
