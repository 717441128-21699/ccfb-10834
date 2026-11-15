import { useMemo } from 'react';
import { useStore } from '../store';
import { buildAdjacency } from '../lineage/impact';
import { TransformType } from '../lineage/types';

const LABEL: Record<TransformType, string> = {
  direct: '原样搬运', compute: '参与计算', aggregate: '聚合', window: '窗口', constant: '常量', star: '星号',
};

export function ColumnDetail() {
  const graph = useStore((s) => s.graph);
  const selectedColumn = useStore((s) => s.selectedColumn);
  const selectColumn = useStore((s) => s.selectColumn);
  const runImpact = useStore((s) => s.runImpact);
  const upstream = useStore((s) => s.upstream);

  const data = useMemo(() => {
    if (!graph || !selectedColumn) return null;
    const { outgoing, incoming } = buildAdjacency(graph);
    const col = graph.columns.get(selectedColumn);
    return {
      col,
      up: incoming.get(selectedColumn) ?? [],
      down: outgoing.get(selectedColumn) ?? [],
      upstreamClosure: upstream,
    };
  }, [graph, selectedColumn, upstream]);

  if (!selectedColumn || !data || !graph) return null;
  const { col, up, down } = data;

  return (
    <div className="detail-pop">
      <h3>{col?.column}</h3>
      <div className="muted" style={{ wordBreak: 'break-all' }}>{col?.table}</div>
      <div className="kv">
        <span className="k">物理列</span><span>{col?.isPhysical ? '是' : '中间产出'}</span>
        <span className="k">数据类型</span><span>{col?.dataType ?? '—'}</span>
        <span className="k">来源文件</span><span>{col?.file ?? '—'}</span>
      </div>

      <button className="primary" style={{ width: '100%', marginBottom: 12 }}
        onClick={() => runImpact(selectedColumn)}>
        假设修改此列,分析下游影响
      </button>

      <h4 style={{ margin: '10px 0 6px', fontSize: 13 }}>直接上游 ({up.length})</h4>
      {up.length === 0 && <div className="faint" style={{ fontSize: 12 }}>无(源头列或常量)</div>}
      {up.map((e) => (
        <div key={e.id} style={{ marginBottom: 8, fontSize: 12.5 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="col-item" style={{ padding: '2px 4px', flex: 1 }}
              onClick={() => e.source && selectColumn(e.source)}>
              {e.source ? e.source : '<常量/字面量>'}
            </span>
            <span className={`tag ${e.transform}`}>{LABEL[e.transform]}</span>
          </div>
          {e.expression && <div className="expr-box">{e.expression}</div>}
        </div>
      ))}

      <h4 style={{ margin: '14px 0 6px', fontSize: 13 }}>直接下游 ({down.length})</h4>
      {down.length === 0 && <div className="faint" style={{ fontSize: 12 }}>无(末端报表列)</div>}
      {down.map((e) => (
        <div key={e.id} style={{ marginBottom: 6, fontSize: 12.5 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="col-item" style={{ padding: '2px 4px', flex: 1 }}
              onClick={() => selectColumn(e.target)}>
              {e.target}
            </span>
            <span className={`tag ${e.transform}`}>{LABEL[e.transform]}</span>
          </div>
        </div>
      ))}

      <h4 style={{ margin: '14px 0 6px', fontSize: 13 }}>全部上游溯源 ({data.upstreamClosure.length})</h4>
      <div style={{ maxHeight: 160, overflow: 'auto' }}>
        {data.upstreamClosure.map((id) => (
          <div key={id} className="col-item" style={{ fontSize: 12 }} onClick={() => selectColumn(id)}>{id}</div>
        ))}
      </div>
    </div>
  );
}
