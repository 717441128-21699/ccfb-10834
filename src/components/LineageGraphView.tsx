import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import { useStore } from '../store';
import { LineageGraph, TransformType } from '../lineage/types';
import { neighborhood } from '../lineage/impact';

const TRANSFORM_COLOR: Record<TransformType, string> = {
  direct: '#56c39a',
  compute: '#e8b34a',
  aggregate: '#c77dff',
  window: '#5aa9ff',
  constant: '#8a93a3',
  star: '#8a93a3',
};

interface Props {
  graph: LineageGraph;
}

export function LineageGraphView({ graph }: Props) {
  const cyRef = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const selectedColumn = useStore((s) => s.selectedColumn);
  const selectColumn = useStore((s) => s.selectColumn);
  const [depth, setDepth] = useState(1);
  const [showLabels, setShowLabels] = useState(true);

  // 邻域子图(几千节点下只渲染选中列周边,保证流畅)
  const elements = useMemo<ElementDefinition[]>(() => {
    if (!selectedColumn) {
      // 未选列:渲染表级骨架(表节点 + 表间聚合边),避免一次性铺出全部列
      return buildTableSkeleton(graph);
    }
    const { nodes, edges } = neighborhood(graph, selectedColumn, depth);
    const els: ElementDefinition[] = [];
    for (const id of nodes) {
      const col = graph.columns.get(id);
      if (!col) continue;
      els.push({
        data: { id, label: col.column, table: col.table, type: 'column' },
        classes: id === selectedColumn ? 'selected' : '',
      });
    }
    for (const e of edges) {
      if (!e.source) continue;
      els.push({
        data: {
          id: e.id, source: e.source, target: e.target,
          label: e.func ?? e.transform, color: TRANSFORM_COLOR[e.transform],
        },
      });
    }
    return els;
  }, [graph, selectedColumn, depth]);

  useEffect(() => {
    if (!cyRef.current) return;
    cy.current = cytoscape({
      container: cyRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': '#2b3d55',
            label: showLabels ? 'data(label)' : '',
            color: '#e6edf6',
            'font-size': 11,
            'text-valign': 'bottom',
            'text-margin-y': 4,
            width: 18, height: 18,
            'border-width': 1, 'border-color': '#4da3ff',
          },
        },
        {
          selector: 'node[type = "table"]',
          style: {
            'background-color': '#1d3a5f',
            shape: 'round-rectangle',
            width: 120, height: 38,
            'font-size': 13, 'font-weight': 'bold',
            'text-valign': 'center', 'text-margin-y': 0,
            'border-color': '#4da3ff', 'border-width': 2,
          },
        },
        { selector: 'node.selected', style: { 'background-color': '#4da3ff', 'border-color': '#fff', width: 24, height: 24 } },
        {
          selector: 'edge',
          style: {
            width: 1.6,
            'line-color': 'data(color)',
            'target-arrow-color': 'data(color)',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: showLabels ? 'data(label)' : '',
            'font-size': '9px', color: '#8da2bd',
            'text-rotation': 'autorotate', 'text-background-color': '#161d28', 'text-background-opacity': 0.85,
            'text-background-padding': '2px',
          },
        },
      ],
      layout: { name: selectedColumn ? 'cose' : 'grid', animate: false, nodeSep: 60, rankSep: 90, padding: 30 } as any,
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.25,
    });

    cy.current.on('tap', 'node', (evt) => {
      const id = evt.target.id();
      if (evt.target.data('type') === 'column') selectColumn(id);
    });
    cy.current.on('tap', (evt) => {
      if (evt.target === cy.current) selectColumn(null);
    });

    return () => { cy.current?.destroy(); cy.current = null; };
    // elements 变化时重建(显式依赖)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, showLabels]);

  return (
    <div className="graph-area">
      <div className="toolbar" style={{ position: 'absolute', top: 10, left: 10, zIndex: 5, marginBottom: 0 }}>
        {selectedColumn && (
          <>
            <span className="muted">展开深度</span>
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {[1, 2, 3, 4].map((d) => <option key={d} value={d}>{d} 层</option>)}
            </select>
          </>
        )}
        <button className={showLabels ? 'primary' : ''} onClick={() => setShowLabels((v) => !v)}>
          {showLabels ? '隐藏标签' : '显示标签'}
        </button>
        {selectedColumn && <button className="ghost" onClick={() => selectColumn(null)}>返回表骨架</button>}
      </div>
      <div id="cy" ref={cyRef} />
      <div className="legend">
        <div className="muted" style={{ marginBottom: 6 }}>加工类型</div>
        {Object.entries(TRANSFORM_COLOR).filter(([k]) => k !== 'star').map(([k, c]) => (
          <div className="item" key={k}><span className="dot" style={{ background: c }} />{transformLabel(k as TransformType)}</div>
        ))}
      </div>
    </div>
  );
}

function transformLabel(t: TransformType): string {
  return { direct: '原样搬运', compute: '参与计算', aggregate: '聚合', window: '窗口', constant: '常量', star: '星号' }[t];
}

/** 表级骨架:每个表一个节点,表间有列血缘则连边 */
function buildTableSkeleton(graph: LineageGraph): ElementDefinition[] {
  const els: ElementDefinition[] = [];
  for (const t of graph.tables.keys()) {
    if (t.startsWith('__')) continue;
    els.push({ data: { id: `tbl::${t}`, label: t, type: 'table' } });
  }
  const tableEdges = new Set<string>();
  for (const e of graph.edges) {
    if (!e.source) continue;
    const src = e.source.split('::')[0];
    const tgt = e.target.split('::')[0];
    if (src === tgt || src.startsWith('__') || tgt.startsWith('__')) continue;
    const key = `${src}->${tgt}`;
    if (tableEdges.has(key)) continue;
    tableEdges.add(key);
    els.push({
      data: { id: `te::${key}`, source: `tbl::${src}`, target: `tbl::${tgt}`, label: '', color: '#4da3ff' },
    });
  }
  return els;
}
