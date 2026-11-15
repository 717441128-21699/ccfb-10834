import { ColumnDiff, DiffResult, ImpactResult, LineageEdge, LineageGraph } from './types';

/** 构建邻接索引 */
export function buildAdjacency(graph: LineageGraph): {
  outgoing: Map<string, LineageEdge[]>;
  incoming: Map<string, LineageEdge[]>;
} {
  const outgoing = new Map<string, LineageEdge[]>();
  const incoming = new Map<string, LineageEdge[]>();
  for (const e of graph.edges) {
    if (!e.source) continue; // 常量边没有上游
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source)!.push(e);
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }
  return { outgoing, incoming };
}

/**
 * 影响分析:假设修改 root 列,求全部下游传递闭包 + 到每个受影响列的加工路径。
 * BFS 同时记录首达路径。
 */
export function analyzeImpact(graph: LineageGraph, rootColumnId: string): ImpactResult {
  const { outgoing } = buildAdjacency(graph);
  const impactedColumns: string[] = [];
  const paths = new Map<string, LineageEdge[]>();
  const queue: { id: string; path: LineageEdge[] }[] = [{ id: rootColumnId, path: [] }];
  const visited = new Set<string>([rootColumnId]);

  while (queue.length) {
    const { id, path } = queue.shift()!;
    const edges = outgoing.get(id) ?? [];
    for (const edge of edges) {
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      const newPath = [...path, edge];
      paths.set(edge.target, newPath);
      impactedColumns.push(edge.target);
      queue.push({ id: edge.target, path: newPath });
    }
  }

  const reportColumns = impactedColumns.filter((id) => {
    const col = graph.columns.get(id);
    return col?.isReport || graph.tables.get(col?.table ?? '')?.kind === 'report';
  });

  return {
    root: rootColumnId,
    impactedColumns,
    reportColumns,
    paths: [...paths.entries()].map(([target, path]) => ({ target, path })),
  };
}

/** 上游溯源:某列依赖哪些源列(反向闭包) */
export function traceUpstream(graph: LineageGraph, columnId: string): string[] {
  const { incoming } = buildAdjacency(graph);
  const result: string[] = [];
  const visited = new Set<string>([columnId]);
  const queue = [columnId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of incoming.get(id) ?? []) {
      if (!edge.source || visited.has(edge.source)) continue;
      visited.add(edge.source);
      result.push(edge.source);
      queue.push(edge.source);
    }
  }
  return result;
}

/** 某列的直接上下游(图渲染用) */
export function neighborhood(graph: LineageGraph, columnId: string, depth = 1): {
  nodes: Set<string>;
  edges: LineageEdge[];
} {
  const { outgoing, incoming } = buildAdjacency(graph);
  const nodes = new Set<string>([columnId]);
  const edges: LineageEdge[] = [];
  let frontier = [columnId];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of outgoing.get(id) ?? []) {
        edges.push(e);
        if (!nodes.has(e.target)) {
          nodes.add(e.target);
          next.push(e.target);
        }
      }
      for (const e of incoming.get(id) ?? []) {
        edges.push(e);
        if (e.source && !nodes.has(e.source)) {
          nodes.add(e.source);
          next.push(e.source);
        }
      }
    }
    frontier = next;
  }
  return { nodes, edges };
}

const TRANSFORM_RANK: Record<string, number> = {
  direct: 1, constant: 1, compute: 2, aggregate: 3, window: 4, star: 1,
};
const isPhysicalId = (id: string) => !id.startsWith('__') && id !== '';

/**
 * 把经过内部合成列的路径压缩成 物理列 -> 物理列 的传递边,
 * transform 取该路径上最强的加工语义。供评测、diff、断言复用。
 */
export function physicalLineage(graph: LineageGraph): {
  source: string;
  target: string;
  transform: LineageEdge['transform'];
  expression?: string;
  func?: string;
}[] {
  const { incoming } = buildAdjacency(graph);
  const out: ReturnType<typeof physicalLineage> = [];
  const seen = new Set<string>();
  for (const target of [...graph.columns.keys()].filter(isPhysicalId)) {
    const stack: { id: string; path: Set<string>; strongest?: LineageEdge }[] = [
      { id: target, path: new Set([target]) },
    ];
    while (stack.length) {
      const { id, path, strongest } = stack.pop()!;
      for (const e of incoming.get(id) ?? []) {
        if (!e.source || path.has(e.source)) continue;
        const stronger =
          !strongest || (TRANSFORM_RANK[e.transform] ?? 0) > (TRANSFORM_RANK[strongest.transform] ?? 0)
            ? e
            : strongest;
        // 物理源(含作为中间层的视图/表):发一条到最终目标的传递边
        if (isPhysicalId(e.source)) {
          const key = `${e.source}->${target}#${stronger.transform}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              source: e.source, target, transform: stronger.transform,
              expression: stronger.expression, func: stronger.func,
            });
          }
        }
        // 无论是否物理列都继续向上游穿透(视图等物理中间层的上游也要追溯),仅路径内防环
        stack.push({ id: e.source, path: new Set(path).add(e.source), strongest: stronger });
      }
    }
  }
  return out;
}

/**
 * 两版图谱比对:以"表::列"为键,比较其物理上游集合与产出表达式。
 * 表达式变化 -> expression-changed(前端标红);仅上游集合变化 -> upstream-changed。
 * 只比较物理表/视图列,忽略引擎内部合成列。
 */
export function diffGraphs(oldGraph: LineageGraph, newGraph: LineageGraph): DiffResult {
  const oldPhysicalTables = new Set([...oldGraph.tables.keys()].filter((t) => !t.startsWith('__')));
  const newPhysicalTables = new Set([...newGraph.tables.keys()].filter((t) => !t.startsWith('__')));
  const addedTables = [...newPhysicalTables].filter((t) => !oldPhysicalTables.has(t));
  const removedTables = [...oldPhysicalTables].filter((t) => !newPhysicalTables.has(t));

  // 物理列视角的上游索引
  const indexOf = (graph: LineageGraph) => {
    const byTarget = new Map<string, ReturnType<typeof physicalLineage>>();
    for (const edge of physicalLineage(graph)) {
      const list = byTarget.get(edge.target) ?? [];
      list.push(edge);
      byTarget.set(edge.target, list);
    }
    return byTarget;
  };
  const oldIdx = indexOf(oldGraph);
  const newIdx = indexOf(newGraph);

  const physicalCols = (graph: LineageGraph) =>
    [...graph.columns.values()].filter((c) => !c.table.startsWith('__'));
  const oldColIds = new Set(physicalCols(oldGraph).map((c) => c.id));
  const newColIds = new Set(physicalCols(newGraph).map((c) => c.id));

  const upstreams = (idx: Map<string, ReturnType<typeof physicalLineage>>, id: string) =>
    [...new Set((idx.get(id) ?? []).map((e) => e.source))].sort();
  const exprSignature = (idx: Map<string, ReturnType<typeof physicalLineage>>, id: string) => {
    const sigs = (idx.get(id) ?? [])
      .filter((e) => e.expression)
      .map((e) => `${e.transform}:${e.expression}`);
    return [...new Set(sigs)].sort().join(' | ') || undefined;
  };

  const columnDiffs: ColumnDiff[] = [];

  for (const col of physicalCols(newGraph)) {
    if (!oldColIds.has(col.id)) {
      columnDiffs.push({
        table: col.table, column: col.column, changeType: 'added',
        oldUpstream: [], newUpstream: upstreams(newIdx, col.id),
        newExpression: exprSignature(newIdx, col.id),
      });
    }
  }
  for (const col of physicalCols(oldGraph)) {
    if (!newColIds.has(col.id)) {
      columnDiffs.push({
        table: col.table, column: col.column, changeType: 'removed',
        oldUpstream: upstreams(oldIdx, col.id), newUpstream: [],
        oldExpression: exprSignature(oldIdx, col.id),
      });
    }
  }
  for (const col of physicalCols(newGraph)) {
    if (!oldColIds.has(col.id)) continue;
    const oldUp = upstreams(oldIdx, col.id);
    const newUp = upstreams(newIdx, col.id);
    const oldExpr = exprSignature(oldIdx, col.id);
    const newExpr = exprSignature(newIdx, col.id);
    const sameUp = JSON.stringify(oldUp) === JSON.stringify(newUp);
    if (oldExpr && newExpr && oldExpr !== newExpr) {
      columnDiffs.push({
        table: col.table, column: col.column, changeType: 'expression-changed',
        oldExpression: oldExpr, newExpression: newExpr, oldUpstream: oldUp, newUpstream: newUp,
      });
    } else if (!sameUp) {
      columnDiffs.push({
        table: col.table, column: col.column, changeType: 'upstream-changed',
        oldExpression: oldExpr, newExpression: newExpr, oldUpstream: oldUp, newUpstream: newUp,
      });
    }
  }

  return { addedTables, removedTables, columnDiffs };
}
