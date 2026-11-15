import { useStore } from '../store';
import { useMemo } from 'react';

export function ImpactPanel() {
  const graph = useStore((s) => s.graph);
  const impact = useStore((s) => s.impact);
  const selectColumn = useStore((s) => s.selectColumn);

  const rows = useMemo(() => {
    if (!impact || !graph) return [];
    return impact.paths
      .map((p) => {
        const targetCol = graph.columns.get(p.target);
        const isReport = graph.tables.get(targetCol?.table ?? '')?.kind === 'report'
          || targetCol?.table.startsWith('RPT');
        return { ...p, targetCol, isReport };
      })
      .sort((a, b) => Number(b.isReport) - Number(a.isReport));
  }, [impact, graph]);

  if (!impact || !graph) {
    return <div className="empty"><div className="icon">🎯</div>在血缘图或左侧表树中选中一列,点击「分析下游影响」</div>;
  }

  const reportHits = rows.filter((r) => r.isReport);

  return (
    <div className="panel">
      <div className="card">
        <h2>影响分析 — {impact.root}</h2>
        <div className="row" style={{ gap: 24 }}>
          <div className="muted">受波及下游列 <b style={{ color: 'var(--warn)', fontSize: 18 }}>{impact.impactedColumns.length}</b> 个</div>
          <div className="muted">其中报表列 <b style={{ color: 'var(--danger)', fontSize: 18 }}>{reportHits.length}</b> 个</div>
        </div>
      </div>

      <div className="card">
        <h2>受波及的报表列</h2>
        {reportHits.length === 0 ? <div className="muted">该列变更不影响任何报表(下游无 RPT 表)</div> : (
          <table className="data">
            <thead><tr><th>报表列</th><th>加工跳数</th><th></th></tr></thead>
            <tbody>
              {reportHits.map((r) => (
                <tr key={r.target}>
                  <td>{r.target}</td>
                  <td>{r.path.length}</td>
                  <td><button onClick={() => selectColumn(r.target)}>查看</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>全部受波及列与加工路径</h2>
        <table className="data">
          <thead><tr><th>目标列</th><th>类型</th><th>中间经过的加工</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.target}>
                <td>
                  <span style={{ cursor: 'pointer', color: r.isReport ? 'var(--danger)' : 'var(--accent)' }}
                    onClick={() => selectColumn(r.target)}>{r.target}</span>
                </td>
                <td>{r.isReport ? <span className="tag compute">报表</span> : <span className="tag">中间</span>}</td>
                <td>
                  <div className="path-chain">
                    <span className="step">{impact.root}</span>
                    {r.path.map((e, i) => (
                      <span key={e.id}>
                        <span className="arrow">──<span className={`tag ${e.transform}`} style={{ margin: '0 4px' }}>{e.func ?? e.transform}</span>──▶</span>
                        <span className="step" onClick={() => selectColumn(e.target)} style={{ cursor: 'pointer' }}>{e.target}</span>
                        {i < r.path.length - 1 ? '' : ''}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
