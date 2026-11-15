import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildLineage, SqlFile } from '../../src/engine';
import { physicalLineage } from '../../src/lineage/impact';
import {
  GOLDEN_EDGE_KEYS,
  GOLDEN_EDGES,
  EXPECTED_UNRESOLVED_DYNAMIC,
  EXPECTED_RESOLVED_DYNAMIC,
} from '../fixtures/golden-lineage';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'fixtures', 'sql');

function loadFiles(): SqlFile[] {
  return readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, content: readFileSync(join(SQL_DIR, f), 'utf-8') }));
}

describe('列级血缘整体评测', () => {
  const files = loadFiles();
  const result = buildLineage(files);
  // 物理列 -> 物理列 的压缩边(穿透引擎内部合成列,transform 取路径最强语义)
  const compressed = physicalLineage(result.graph);
  const producedKeys = new Set(compressed.map((c) => `${c.source}->${c.target}`));

  it('解析无致命错误', () => {
    const errors = result.graph.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('列级召回率 >= 95%', () => {
    const hit = [...GOLDEN_EDGE_KEYS].filter((k) => producedKeys.has(k));
    const recall = hit.length / GOLDEN_EDGE_KEYS.size;
    console.log(`\n[召回] 命中 ${hit.length}/${GOLDEN_EDGE_KEYS.size} = ${(recall * 100).toFixed(2)}%`);
    const missing = [...GOLDEN_EDGE_KEYS].filter((k) => !producedKeys.has(k));
    if (missing.length) console.log('  缺失:', missing);
    expect(recall).toBeGreaterThanOrEqual(0.95);
  });

  it('列级精确率 >= 95%', () => {
    const correct = [...producedKeys].filter((k) => GOLDEN_EDGE_KEYS.has(k));
    const precision = correct.length / producedKeys.size;
    console.log(`\n[精确] 正确 ${correct.length}/${producedKeys.size} = ${(precision * 100).toFixed(2)}%`);
    const extra = [...producedKeys].filter((k) => !GOLDEN_EDGE_KEYS.has(k));
    if (extra.length) console.log('  多余:', extra);
    expect(precision).toBeGreaterThanOrEqual(0.95);
  });

  it('加工类型(direct/compute/aggregate/window)判定准确率 >= 95%', () => {
    const goldenByKey = new Map(GOLDEN_EDGES.map((e) => [`${e.source}->${e.target}`, e.transform]));
    let total = 0;
    let matched = 0;
    const mismatches: string[] = [];
    for (const c of compressed) {
      const key = `${c.source}->${c.target}`;
      const expected = goldenByKey.get(key);
      if (!expected) continue; // 精确率维度已覆盖多余边
      total++;
      if (expected === c.transform) matched++;
      else mismatches.push(`${key} 期望=${expected} 实际=${c.transform}`);
    }
    const acc = total === 0 ? 0 : matched / total;
    console.log(`\n[加工类型] ${matched}/${total} = ${(acc * 100).toFixed(2)}%`);
    if (mismatches.length) console.log('  不一致:', mismatches);
    expect(acc).toBeGreaterThanOrEqual(0.95);
  });

  it('星号展开得到正确的物理列', () => {
    const vDetail = result.graph.tables.get('V_SALES_DETAIL');
    expect(vDetail?.columns).toEqual(
      expect.arrayContaining(['CUST_ID', 'CUST_NAME', 'REGION', 'TOTAL_RMB', 'ORDER_CNT', 'VIP_TAG']),
    );
  });

  it('动态 SQL:可识别的还原、不可识别的单列', () => {
    const resolved = result.dynamicSql.filter((d) => d.resolved).length;
    const unresolved = result.graph.issues.filter((i) => i.code === 'DYNAMIC_SQL').length;
    console.log(`\n[动态SQL] 已还原=${resolved} 未识别单列=${unresolved}`);
    expect(resolved).toBe(EXPECTED_RESOLVED_DYNAMIC);
    expect(unresolved).toBe(EXPECTED_UNRESOLVED_DYNAMIC);
  });

  it('报表表被正确归类', () => {
    expect(result.graph.tables.get('RPT_SALES')).toBeDefined();
    expect(result.graph.tables.get('RPT_CUST_ENRICHED')).toBeDefined();
  });
});
