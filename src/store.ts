import { create } from 'zustand';
import { SqlFile, buildLineage } from './engine';
import { PlainGraph, deserializeGraph } from './lineage/serialize';
import { LineageGraph, DiffResult, ImpactResult } from './lineage/types';
import { analyzeImpact, traceUpstream, diffGraphs } from './lineage/impact';
import { parseInWorker } from './workers/worker-client';

export type TabKey = 'graph' | 'impact' | 'diff' | 'issues' | 'scripts';

function toPlain(graph: LineageGraph): PlainGraph {
  return {
    columns: [...graph.columns.values()].map((c) => ({ ...c })),
    tables: [...graph.tables.values()].map((t) => ({ ...t })),
    edges: graph.edges,
    issues: graph.issues,
    dynamicSql: graph.dynamicSql,
    stats: {
      tableCount: graph.tables.size,
      columnCount: graph.columns.size,
      edgeCount: graph.edges.length,
    },
  };
}

interface AppState {
  files: SqlFile[];
  graph: LineageGraph | null;
  plainGraph: PlainGraph | null;
  loading: boolean;
  elapsedMs: number;
  statementCount: number;
  activeTab: TabKey;
  selectedColumn: string | null;
  impact: ImpactResult | null;
  upstream: string[];
  error: string | null;

  addFiles: (files: SqlFile[]) => Promise<void>;
  rebuild: (files: SqlFile[]) => Promise<void>;
  removeFile: (name: string) => void;
  clearAll: () => void;
  setTab: (tab: TabKey) => void;
  selectColumn: (id: string | null) => void;
  runImpact: (id: string) => void;
  computeDiff: (oldFiles: SqlFile[], newFiles: SqlFile[]) => DiffResult;
}

export const useStore = create<AppState>((set, get) => ({
  files: [],
  graph: null,
  plainGraph: null,
  loading: false,
  elapsedMs: 0,
  statementCount: 0,
  activeTab: 'graph',
  selectedColumn: null,
  impact: null,
  upstream: [],
  error: null,

  addFiles: async (incoming) => {
    set({ loading: true, error: null });
    try {
      const merged = new Map(get().files.map((f) => [f.name, f]));
      for (const f of incoming) merged.set(f.name, f);
      await get().rebuild([...merged.values()]);
      set({ loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  rebuild: async (files) => {
    // 优先走 Web Worker,大文件解析不阻塞 UI;Worker 不可用时退回主线程
    let graph: LineageGraph;
    let plain: PlainGraph;
    let statementCount: number;
    let elapsedMs: number;
    try {
      const r = await parseInWorker(files);
      graph = deserializeGraph(r.graph);
      plain = r.graph;
      statementCount = r.statementCount;
      elapsedMs = r.elapsedMs;
    } catch {
      const start = performance.now();
      const result = buildLineage(files);
      graph = result.graph;
      plain = toPlain(graph);
      statementCount = result.statementCount;
      elapsedMs = performance.now() - start;
    }
    set({
      files, graph, plainGraph: plain, statementCount, elapsedMs,
      selectedColumn: null, impact: null, upstream: [],
    });
  },

  removeFile: (name) => {
    const files = get().files.filter((f) => f.name !== name);
    if (!files.length) {
      get().clearAll();
      return;
    }
    void get().rebuild(files);
  },

  clearAll: () =>
    set({
      files: [], graph: null, plainGraph: null, selectedColumn: null,
      impact: null, upstream: [], error: null, statementCount: 0, elapsedMs: 0,
    }),

  setTab: (tab) => set({ activeTab: tab }),

  selectColumn: (id) => {
    if (!id) {
      set({ selectedColumn: null, impact: null, upstream: [] });
      return;
    }
    const graph = get().graph;
    const upstream = graph ? traceUpstream(graph, id) : [];
    set({ selectedColumn: id, upstream, impact: null });
  },

  runImpact: (id) => {
    const graph = get().graph;
    if (!graph) return;
    const impact = analyzeImpact(graph, id);
    set({ impact, selectedColumn: id, activeTab: 'impact' });
  },

  computeDiff: (oldFiles, newFiles) => {
    const oldGraph = buildLineage(oldFiles).graph;
    const newGraph = buildLineage(newFiles).graph;
    return diffGraphs(oldGraph, newGraph);
  },
}));
