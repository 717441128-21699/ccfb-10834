import { SqlFile } from '../engine';
import { PlainGraph } from '../lineage/serialize';
import type { WorkerRequest, WorkerResponse } from './parser.worker';

let worker: Worker | null = null;
let seq = 0;

function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

export function parseInWorker(files: SqlFile[]): Promise<Omit<WorkerResponse, 'id' | 'type'>> {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = ++seq;
    const handler = (ev: MessageEvent<WorkerResponse>) => {
      if (ev.data.id !== id) return;
      w.removeEventListener('message', handler);
      const { graph, fileCount, statementCount, dynamicCount, elapsedMs } = ev.data;
      resolve({ graph, fileCount, statementCount, dynamicCount, elapsedMs });
    };
    const errHandler = (ev: ErrorEvent) => reject(ev.error ?? new Error(ev.message));
    w.addEventListener('message', handler);
    w.addEventListener('error', errHandler, { once: true });
    const req: WorkerRequest = { id, type: 'parse', files };
    w.postMessage(req);
  });
}

export type { PlainGraph };
