import { useRef, useState } from 'react';
import { useStore } from '../store';
import { SqlFile, detectDialect } from '../engine';

export function FileImporter() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const addFiles = useStore((s) => s.addFiles);
  const loading = useStore((s) => s.loading);

  const readFiles = async (fileList: FileList | File[]) => {
    const files: SqlFile[] = [];
    for (const f of Array.from(fileList)) {
      if (!/\.(sql|txt|hql|ddl|prc|pls)$/i.test(f.name)) continue;
      const content = await f.text();
      files.push({ name: f.name, content, dialect: detectDialect(content) });
    }
    if (files.length) await addFiles(files);
  };

  return (
    <div
      className={`dropzone ${drag ? 'drag' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void readFiles(e.dataTransfer.files);
      }}
    >
      <div className="big">{loading ? '解析中…' : '点击或拖拽导入 SQL 文件'}</div>
      <div className="muted">支持 .sql / .hql / .ddl / .prc / .pls,可多选,Oracle 与 Hive 自动识别</div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".sql,.txt,.hql,.ddl,.prc,.pls"
        style={{ display: 'none' }}
        onChange={(e) => e.target.files && void readFiles(e.target.files)}
      />
    </div>
  );
}
