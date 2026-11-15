import { useStore } from '../store';

const SEV_LABEL = { error: '错误', warn: '警告', info: '提示' } as const;

export function IssuesPanel() {
  const graph = useStore((s) => s.graph);
  if (!graph) return <div className="empty"><div className="icon">📋</div>先导入 SQL 文件</div>;

  const dynamic = graph.dynamicSql;

  return (
    <div className="panel">
      <div className="card">
        <h2>问题清单 ({graph.issues.length})</h2>
        {graph.issues.length === 0 ? <div className="muted">无解析问题,所有列均成功解析</div> : (
          <table className="data">
            <thead><tr><th>级别</th><th>类型</th><th>文件</th><th>行</th><th>说明</th></tr></thead>
            <tbody>
              {graph.issues.map((iss, i) => (
                <tr key={i}>
                  <td className={`sev-${iss.severity}`}>{SEV_LABEL[iss.severity]}</td>
                  <td><code>{iss.code}</code></td>
                  <td>{iss.file ?? '—'}</td>
                  <td>{iss.startLine ?? '—'}</td>
                  <td>{iss.message}{iss.snippet ? <div className="expr-box">{iss.snippet}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>动态 SQL 识别 ({dynamic.length})</h2>
        <div className="muted" style={{ marginBottom: 10 }}>
          字符串拼接的动态 SQL:能静态还原的已自动纳入血缘;无法还原的在此单列,需人工确认。
        </div>
        {dynamic.length === 0 ? <div className="muted">未发现动态 SQL</div> : (
          <table className="data">
            <thead><tr><th>状态</th><th>文件</th><th>行</th><th>原始代码 / 还原结果</th></tr></thead>
            <tbody>
              {dynamic.map((d, i) => (
                <tr key={i}>
                  <td>
                    {d.resolved
                      ? <span className="tag direct">已识别</span>
                      : <span className="tag compute">待人工确认</span>}
                  </td>
                  <td>{d.file ?? '—'}</td>
                  <td>{d.startLine}</td>
                  <td>
                    <div className="expr-box"><span className="faint">原始:</span>{d.raw}</div>
                    {d.resolvedSql && <div className="expr-box new"><span className="faint">还原:</span>{d.resolvedSql}</div>}
                    {d.reason && <div className="sev-warn" style={{ fontSize: 12 }}>{d.reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
