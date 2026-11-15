import { useState } from 'react';
import { useStore } from '../store';

export function ScriptsPanel() {
  const files = useStore((s) => s.files);
  const removeFile = useStore((s) => s.removeFile);
  const graph = useStore((s) => s.graph);
  const [active, setActive] = useState<string | null>(files[0]?.name ?? null);

  if (!files.length) return <div className="empty"><div className="icon">🗂️</div>脚本库为空,请先导入 SQL 文件</div>;
  const current = files.find((f) => f.name === active) ?? files[0];

  return (
    <div className="panel" style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div className="card" style={{ width: 260, flexShrink: 0, marginBottom: 0, overflow: 'auto' }}>
        <h2>脚本库 ({files.length})</h2>
        {files.map((f) => {
          const tableCount = graph
            ? [...graph.tables.values()].filter((t) => t.file === f.name).length
            : 0;
          return (
            <div key={f.name} className={`table-item ${current.name === f.name ? 'sel' : ''}`}
              onClick={() => setActive(f.name)}>
              <div className="tname" style={{ fontSize: 12.5 }}>{f.name}</div>
              <div className="meta">{f.dialect ?? 'generic'} · {tableCount} 个产出对象</div>
            </div>
          );
        })}
      </div>
      <div className="card" style={{ flex: 1, marginBottom: 0, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{current.name}</h2>
          <button className="ghost" style={{ color: 'var(--danger)' }} onClick={() => removeFile(current.name)}>
            移除
          </button>
        </div>
        <pre className="expr-box" style={{ flex: 1, overflow: 'auto', marginTop: 12 }}>{current.content}</pre>
      </div>
    </div>
  );
}
