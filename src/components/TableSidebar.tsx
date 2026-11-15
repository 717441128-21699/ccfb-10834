import { useMemo, useState } from 'react';
import { useStore } from '../store';

export function TableSidebar() {
  const graph = useStore((s) => s.graph);
  const selectedColumn = useStore((s) => s.selectedColumn);
  const selectColumn = useStore((s) => s.selectColumn);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tables = useMemo(() => {
    if (!graph) return [];
    return [...graph.tables.values()]
      .filter((t) => !t.name.startsWith('__'))
      .filter((t) => {
        if (!query) return true;
        const q = query.toUpperCase();
        return t.name.includes(q) || t.columns.some((c) => c.includes(q));
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [graph, query]);

  const toggle = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="sidebar">
      <input
        className="search-box"
        style={{ width: '100%', marginBottom: 10 }}
        placeholder="搜索表名 / 列名…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
        {tables.length} 张表 · 点击列查看上下游
      </div>
      {tables.map((t) => {
        const isCollapsed = collapsed.has(t.name);
        const visibleCols = query
          ? t.columns.filter((c) => c.includes(query.toUpperCase()))
          : t.columns;
        return (
          <div key={t.name} className="table-node">
            <div className="table-item" onClick={() => toggle(t.name)}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="tname">{isCollapsed ? '▸' : '▾'} {t.name}</span>
                <span className="tag" style={{ background: 'var(--bg-elev2)' }}>{t.kind}</span>
              </div>
              <div className="meta">{t.columns.length} 列{t.file ? ` · ${t.file}` : ''}</div>
            </div>
            {!isCollapsed && (
              <div className="col-list">
                {visibleCols.map((c) => {
                  const id = `${t.name}::${c}`;
                  return (
                    <div
                      key={c}
                      className={`col-item ${selectedColumn === id ? 'sel' : ''}`}
                      onClick={() => selectColumn(id)}
                      title={id}
                    >
                      <span>{c}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
