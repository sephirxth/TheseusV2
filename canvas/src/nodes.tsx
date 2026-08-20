// 三类节点，组件表就是类型注册表：镜像（意图）、幽灵（提议）、原生（便签）。
// 尺度：字号 = 基准 × 创建时的尺度 s，其余尺寸全用 em 跟着走——
// 缩得远建的东西大，凑近建的小；大小是人赋予的语义，不是装饰。

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';

export type IntentFlowNode = Node<{
  saying: string;
  status: 'open' | 'done' | 'dropped';
  isCurrent: boolean;
  mergedCount: number;
  bornText: string;
  s: number;
}, 'intent'>;

/** 镜像节点：树上的一条意图。数据活在痕迹里，这儿只负责长得像它。 */
export function IntentNodeView({ data, selected }: NodeProps<IntentFlowNode>) {
  return (
    <div
      className={`intent-node s-${data.status}${data.isCurrent ? ' current' : ''}${selected ? ' selected' : ''}`}
      style={{ fontSize: `${14 * data.s}px` }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="saying">
        {data.status === 'done' ? '✓ ' : ''}{data.saying}
      </div>
      <div className="meta">
        {data.isCurrent ? <span className="tag-current">当前</span> : null}
        {data.status === 'dropped' ? <span className="tag-dropped">不做了</span> : null}
        {data.mergedCount > 0 ? <span className="tag-merged">已并 {data.mergedCount}</span> : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export type GhostFlowNode = Node<{
  text: string;
  suspended: boolean;
  s: number;
  onAdopt: (proposalId: string) => void;
}, 'ghost'>;

/** 幽灵节点：agent 提的，树上不算数。认了那一下才是授权，节点就在原位实体化。 */
export function GhostNodeView({ id, data }: NodeProps<GhostFlowNode>) {
  return (
    <div className={`ghost-node${data.suspended ? ' suspended' : ''}`} style={{ fontSize: `${14 * data.s}px` }}>
      <Handle type="target" position={Position.Left} />
      <div className="g-chip">[意图·猜的]{data.suspended ? ' ⏸' : ''}</div>
      <div className="saying">{data.text}</div>
      <button className="g-adopt nodrag" onClick={() => data.onAdopt(id)}>认领</button>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export type NoteFlowNode = Node<{
  text: string;
  s: number;
  onText: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}, 'note'>;

/** 原生节点：便签。它只活在布局里——画布坏了，丢的是它，不是任何事实。 */
export function NoteNodeView({ id, data }: NodeProps<NoteFlowNode>) {
  return (
    <div className="note-node" style={{ fontSize: `${13 * data.s}px` }}>
      <button className="note-x nodrag" title="删掉这张便签" onClick={() => data.onRemove(id)}>×</button>
      <textarea
        className="nodrag"
        defaultValue={data.text}
        placeholder="写点什么…"
        onBlur={(e) => data.onText(id, e.target.value)}
      />
    </div>
  );
}
