import { buildLineage, SqlFile } from '../engine';
import { serializeGraph } from '../lineage/serialize';

export interface WorkerRequest {
  id: number;
  type: 'parse';
  files: SqlFile[];
}

export interface WorkerResponse {
  id: number;
  type: 'result';
  graph: ReturnType<typeof serializeGraph>;
  fileCount: number;
  statementCount: number;
  dynamicCount: number;
  elapsedMs: number;
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type !== 'parse') return;
  const start = performance.now();
  const result = buildLineage(req.files);
  const elapsedMs = performance.now() - start;
  const resp: WorkerResponse = {
    id: req.id,
    type: 'result',
    graph: serializeGraph(result.graph),
    fileCount: result.fileCount,
    statementCount: result.statementCount,
    dynamicCount: result.dynamicSql.length,
    elapsedMs,
  };
  self.postMessage(resp);
};
