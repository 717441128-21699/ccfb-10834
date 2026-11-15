import { LineageGraph } from './types';

export interface PlainGraph {
  columns: { id: string; table: string; column: string; file?: string; isPhysical: boolean; isReport?: boolean; dataType?: string }[];
  tables: { name: string; columns: string[]; file?: string; kind: string; dialect?: string }[];
  edges: LineageGraph['edges'];
  issues: LineageGraph['issues'];
  dynamicSql: LineageGraph['dynamicSql'];
  stats: { tableCount: number; columnCount: number; edgeCount: number };
}

export function serializeGraph(graph: LineageGraph): PlainGraph {
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

export function deserializeGraph(plain: PlainGraph): LineageGraph {
  return {
    columns: new Map(plain.columns.map((c) => [c.id, c])),
    tables: new Map(plain.tables.map((t) => [t.name, t as LineageGraph['tables'] extends Map<string, infer V> ? V : never])),
    edges: plain.edges,
    issues: plain.issues,
    dynamicSql: plain.dynamicSql,
  };
}
