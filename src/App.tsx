import { useStore, TabKey } from './store';
import { GraphTab } from './components/GraphTab';
import { ImpactPanel } from './components/ImpactPanel';
import { DiffPanel } from './components/DiffPanel';
import { IssuesPanel } from './components/IssuesPanel';
import { ScriptsPanel } from './components/ScriptsPanel';
import { FileImporter } from './components/FileImporter';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'graph', label: '血缘图' },
  { key: 'impact', label: '影响分析' },
  { key: 'diff', label: '算法比对' },
  { key: 'issues', label: '问题清单' },
  { key: 'scripts', label: '脚本库' },
];

export default function App() {
  const activeTab = useStore((s) => s.activeTab);
  const setTab = useStore((s) => s.setTab);
  const plain = useStore((s) => s.plainGraph);
  const files = useStore((s) => s.files);
  const clearAll = useStore((s) => s.clearAll);
  const loading = useStore((s) => s.loading);
  const elapsedMs = useStore((s) => s.elapsedMs);
  const statementCount = useStore((s) => s.statementCount);
  const error = useStore((s) => s.error);

  return (
    <div className="app">
      <header className="app-header">
        <h1>列级血缘追踪平台</h1>
        {plain && (
          <div className="stats">
            <span>表/视图 <b>{plain.stats.tableCount}</b></span>
            <span>列节点 <b>{plain.stats.columnCount}</b></span>
            <span>血缘边 <b>{plain.stats.edgeCount}</b></span>
            <span>语句 <b>{statementCount}</b></span>
            <span>解析耗时 <b>{elapsedMs.toFixed(1)}ms</b></span>
          </div>
        )}
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={activeTab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
        {files.length > 0 && <button className="ghost" onClick={clearAll}>清空</button>}
      </header>

      {loading && <div className="panel">解析中…</div>}
      {error && <div className="panel sev-error">出错了:{error}</div>}

      {!loading && !error && (
        <main className="app-body" style={{ flex: 1, minHeight: 0 }}>
          {activeTab === 'graph' && <GraphTab />}
          {activeTab === 'impact' && <ImpactPanel />}
          {activeTab === 'diff' && <DiffPanel />}
          {activeTab === 'issues' && <IssuesPanel />}
          {activeTab === 'scripts' && (files.length ? <ScriptsPanel /> : (
            <div className="panel" style={{ width: '100%' }}><FileImporter /></div>
          ))}
        </main>
      )}
    </div>
  );
}
