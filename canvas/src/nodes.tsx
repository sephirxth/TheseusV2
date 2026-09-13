// Three node kinds; the component table is the type registry: mirror (intent), ghost (proposal), native (note).
// Scale: font size = base x s, all other sizes follow via em. s comes from the zoom level at creation,
// and can be adjusted afterwards (bottom-right handle / Shift+wheel) — size is human-given semantics, part of the layout.

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';

const clampS = (v: number): number => Math.min(10, Math.max(0.35, v));

/** Bottom-right handle: drag to change s. Live local preview while dragging; archives on release (onScale). */
function useScaleDrag(id: string, s: number, onScale: (id: string, s: number) => void) {
  const [live, setLive] = useState<number | null>(null);
  const start = useRef<{ x0: number; s0: number; w0: number } | null>(null);
  const liveRef = useRef<number | null>(null);
  const set = (v: number | null) => { liveRef.current = v; setLive(v); };

  const grip = {
    className: 'resize-grip nodrag',
    title: 'drag to resize (Shift+wheel works too)',
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
  /** Time property (the moment of the birth utterance); shown in timeline projection. */
  date?: string;
  onScale: (id: string, s: number) => void;
}, 'intent'>;

/** Mirror node: one intent on the tree. Data lives in traces; this only renders it. */
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
        {data.isCurrent ? <span className="tag-current">current</span> : null}
        {data.status === 'dropped' ? <span className="tag-dropped">dropped</span> : null}
        {data.mergedCount > 0 ? <span className="tag-merged">merged {data.mergedCount}</span> : null}
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

/** Ghost node: agent-proposed, not counted on the tree. The acceptance click is the authorization; the node materializes in place. */
export function GhostNodeView({ id, data }: NodeProps<GhostFlowNode>) {
  const { scale, grip } = useScaleDrag(id, data.s, data.onScale);
  return (
    <div className={`ghost-node${data.suspended ? ' suspended' : ''}`} style={{ fontSize: `${14 * scale}px` }}>
      <Handle type="target" position={Position.Left} />
      <div className="g-chip">
        [intent·guess]{data.suspended ? ' ⏸' : ''}
        {data.date !== undefined ? <span className="tag-date">{data.date}</span> : null}
      </div>
      <div className="saying">{data.text}</div>
      <button className="g-adopt nodrag" onClick={() => data.onAdopt(id)}>accept</button>
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

/** Native node: a note. It lives in layout only — if the canvas breaks, what is lost is it, never any fact.
 *  It also has connection points: a note attached to something is a native relation (annotation), not a tree edge. */
export function NoteNodeView({ id, data }: NodeProps<NoteFlowNode>) {
  const { scale, grip } = useScaleDrag(id, data.s, data.onScale);
  return (
    <div className="note-node" style={{ fontSize: `${13 * scale}px` }}>
      <Handle type="target" position={Position.Left} />
      <button className="note-x nodrag" title="delete this note" onClick={() => data.onRemove(id)}>×</button>
      <textarea
        className="nodrag"
        defaultValue={data.text}
        placeholder="write something..."
        onBlur={(e) => data.onText(id, e.target.value)}
      />
      {data.date !== undefined ? <div className="note-date">{data.date}</div> : null}
      <div {...grip} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
