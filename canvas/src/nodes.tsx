// 两类节点，两种本体（镜像/原生），各自一个组件——组件表就是类型注册表：
// 以后每加一类对象（agent 卡、审阅项、Operator Brief），都只是往这张表里加一行。

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';

export type IntentFlowNode = Node<{
  saying: string;
  status: 'open' | 'done' | 'dropped';
  isCurrent: boolean;
  mergedCount: number;
  bornText: string;
}, 'intent'>;

/** 镜像节点：树上的一条意图。数据活在痕迹里，这儿只负责长得像它。 */
export function IntentNodeView({ data, selected }: NodeProps<IntentFlowNode>) {
  return (
    <div className={`intent-node s-${data.status}${data.isCurrent ? ' current' : ''}${selected ? ' selected' : ''}`}>
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

export type NoteFlowNode = Node<{
  text: string;
  onText: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}, 'note'>;

/** 原生节点：便签。它只活在布局里——画布坏了，丢的是它，不是任何事实。 */
export function NoteNodeView({ id, data }: NodeProps<NoteFlowNode>) {
  return (
    <div className="note-node">
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
