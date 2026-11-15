import { useState } from 'react';
import { useStore } from '../store';
import { SqlFile, detectDialect } from '../engine';
import { ColumnDiff } from '../lineage/types';

async function readList(list: FileList | null): Promise<SqlFile[]> {
  if (!list) return [];
  const out: SqlFile[] = [];
  for (const f of Array.from(list)) {
    const content = await f.text();
    out.push({ name: f.name, content, dialect: detectDialect(content) });
  }
  return out;
}

const CHANGE_LABEL: Record<ColumnDiff['changeType'], { text: string; cls: string }> = {
  added: { text: '新增列', cls: 'diff-added' },
  removed: { text: '删除列', cls: 'diff-removed' },
  'expression-changed': { text: '算法变更', cls: 'diff-changed' },
  'upstream-changed': { text: '上游变化', cls: 'diff-changed' },
  unchanged: { text: '未变', cls: 'muted' },
};

export function DiffPanel() {
  const computeDiff = useStore((s) => s.computeDiff);
  const [oldFiles, setOldFiles] = useState<SqlFile[]>([]);
  const [newFiles, setNewFiles] = useState<SqlFile[]>([]);
  const [diffs, setDiffs] = useState<ReturnType<typeof computeDiff> | null>(null);

  const run = () => {
    if (!oldFiles.length || !newFiles.length) return;
    setDiffs(computeDiff(oldFiles, newFiles));
  };

  const changed = diffs?.columnDiffs.filter((d) => d.changeType !== 'unchanged') ?? [];

  return (
    <div className="panel">
      <div className="card">
        <h2>新旧脚本算法比对</h2>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div className="muted" style={{ marginBottom: 6 }}>旧版本脚本</div>
            <input type="file" multiple onChange={async (e) => setOldFiles(await readList(e.target.files))} />
            <div className="faint" style={{ marginTop: 6 }}>{oldFiles.map((f) => f.name).join(', ') || '未选择'}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div className="muted" style={{ marginBottom: 6 }}>新版本脚本</div>
            <input type="file" multiple onChange={async (e) => setNewFiles(await readList(e.target.files))} />
            <div className="faint" style={{ marginTop: 6 }}>{newFiles.map((f) => f.name).join(', ') || '未选择'}</div>
          </div>
          <button className="primary" disabled={!oldFiles.length || !newFiles.length} onClick={run} style={{ marginTop: 22 }}>
            开始比对
          </button>
        </div>
      </div>

      {diffs && (
        <>
          <div className="card">
            <h2>变更概览</h2>
            <div className="row" style={{ gap: 24 }}>
              <div className="muted">新增表 <b className="diff-added">{diffs.addedTables.length}</b></div>
              <div className="muted">删除表 <b className="diff-removed">{diffs.removedTables.length}</b></div>
              <div className="muted">变化的列 <b className="diff-changed">{changed.length}</b></div>
            </div>
            {diffs.addedTables.length > 0 && <div className="muted" style={{ marginTop: 8 }}>新增:{diffs.addedTables.join(', ')}</div>}
            {diffs.removedTables.length > 0 && <div className="muted">删除:{diffs.removedTables.join(', ')}</div>}
          </div>

          <div className="card">
            <h2>列级差异(算法变更列已标红)</h2>
            {changed.length === 0 ? <div className="muted">两版脚本列级血缘完全一致</div> : (
              <table className="data">
                <thead><tr><th>表</th><th>列</th><th>变更</th><th>表达式 / 上游对比</th></tr></thead>
                <tbody>
                  {changed.map((d, i) => {
                    const meta = CHANGE_LABEL[d.changeType];
                    const isExpr = d.changeType === 'expression-changed';
                    return (
                      <tr key={`${d.table}::${d.column}-${i}`} className={isExpr ? 'diff-changed' : ''}>
                        <td>{d.table}</td>
                        <td><b>{d.column}</b></td>
                        <td><span className={meta.cls}>{meta.text}</span></td>
                        <td style={{ minWidth: 320 }}>
                          {d.oldExpression && <div className="expr-box old"><span className="faint">旧:</span>{d.oldExpression}</div>}
                          {d.newExpression && <div className="expr-box new"><span className="faint">新:</span>{d.newExpression}</div>}
                          {!d.oldExpression && !d.newExpression && (
                            <div style={{ fontSize: 12 }}>
                              <div className="diff-removed">旧上游:{d.oldUpstream.join(', ') || '无'}</div>
                              <div className="diff-added">新上游:{d.newUpstream.join(', ') || '无'}</div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
