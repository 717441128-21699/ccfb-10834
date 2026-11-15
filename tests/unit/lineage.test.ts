import { describe, it, expect } from 'vitest';
import { buildLineage, SqlFile } from '../../src/engine';
import { analyzeImpact, traceUpstream, diffGraphs, physicalLineage } from '../../src/lineage/impact';

function run(sql: string, ddl = '') {
  const files: SqlFile[] = [];
  if (ddl) files.push({ name: 'ddl.sql', content: ddl });
  files.push({ name: 'q.sql', content: sql });
  return buildLineage(files).graph;
}

/** 物理列 -> 物理列 的压缩边,断言用 */
function physEdges(g: ReturnType<typeof run>) {
  return physicalLineage(g);
}
const findEdge = (g: ReturnType<typeof run>, source: string, targetPrefix: string) =>
  physEdges(g).find((e) => e.source === source && e.target.startsWith(targetPrefix));

const BASE_DDL = `
CREATE TABLE t_a (id BIGINT, name STRING, amt DECIMAL(18,2), rate DECIMAL(10,4), region STRING);
CREATE TABLE t_b (id BIGINT, tag STRING, amt DECIMAL(18,2));
CREATE TABLE t_out (id BIGINT, nm STRING, rmb DECIMAL(18,2), tag STRING, rn BIGINT);
`;

describe('解析与列级血缘', () => {
  it('原样搬运 vs 参与计算可区分', () => {
    const g = run(
      `INSERT INTO t_out (id, nm, rmb)
       SELECT id, name, amt * rate AS rmb FROM t_a;`,
      BASE_DDL,
    );
    expect(findEdge(g, 'T_A::ID', 'T_OUT')?.transform).toBe('direct');
    expect(findEdge(g, 'T_A::AMT', 'T_OUT')?.transform).toBe('compute');
    expect(findEdge(g, 'T_A::RATE', 'T_OUT')?.transform).toBe('compute');
  });

  it('聚合函数标记为 aggregate', () => {
    const g = run(
      `INSERT INTO t_out (id, rmb) SELECT region, SUM(amt) FROM t_a GROUP BY region;`,
      BASE_DDL,
    );
    expect(findEdge(g, 'T_A::AMT', 'T_OUT')?.transform).toBe('aggregate');
  });

  it('窗口函数的分区/排序列标记为 window', () => {
    const g = run(
      `INSERT INTO t_out (id, rn)
       SELECT id, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amt DESC) AS rn FROM t_a;`,
      BASE_DDL,
    );
    expect(findEdge(g, 'T_A::REGION', 'T_OUT::RN')?.transform).toBe('window');
    expect(findEdge(g, 'T_A::AMT', 'T_OUT::RN')?.transform).toBe('window');
  });

  it('CTE 多层引用正确透传到物理源', () => {
    const g = run(
      `WITH c1 AS (SELECT id, name FROM t_a),
              c2 AS (SELECT id, name FROM c1)
       INSERT INTO t_out (id, nm) SELECT id, name FROM c2;`,
      BASE_DDL,
    );
    expect(findEdge(g, 'T_A::ID', 'T_OUT::ID')).toBeDefined();
    expect(findEdge(g, 'T_A::NAME', 'T_OUT::NM')).toBeDefined();
  });

  it('JOIN 两侧列都进入血缘', () => {
    const g = run(
      `INSERT INTO t_out (id, nm, tag)
       SELECT a.id, a.name, b.tag FROM t_a a JOIN t_b b ON a.id = b.id;`,
      BASE_DDL,
    );
    expect(findEdge(g, 'T_B::TAG', 'T_OUT::TAG')).toBeDefined();
    expect(findEdge(g, 'T_A::NAME', 'T_OUT::NM')).toBeDefined();
  });

  it('UNION ALL 两分支按位置汇合', () => {
    const g = run(
      `INSERT INTO t_out (id, nm)
       SELECT id, name FROM t_a UNION ALL SELECT id, tag FROM t_b;`,
      BASE_DDL,
    );
    expect(findEdge(g, 'T_A::NAME', 'T_OUT::NM')).toBeDefined();
    expect(findEdge(g, 'T_B::TAG', 'T_OUT::NM')).toBeDefined();
  });

  it('星号依据 DDL 列清单展开', () => {
    const g = run(`CREATE VIEW v_star AS SELECT * FROM t_a;`, BASE_DDL);
    expect(g.tables.get('V_STAR')?.columns).toEqual(['ID', 'NAME', 'AMT', 'RATE', 'REGION']);
    // 星号展开后每个物理列都有 direct 边到视图
    for (const c of ['ID', 'NAME', 'AMT', 'RATE', 'REGION']) {
      expect(findEdge(g, `T_A::${c}`, `V_STAR::${c}`)?.transform).toBe('direct');
    }
  });

  it('子查询作用域独立解析', () => {
    const g = run(
      `INSERT INTO t_out (id, rmb)
       SELECT id, (SELECT MAX(amt) FROM t_b WHERE t_b.id = t_a.id) FROM t_a;`,
      BASE_DDL,
    );
    expect(findEdge(g, 'T_B::AMT', 'T_OUT::RMB')).toBeDefined();
  });

  it('CASE 表达式的所有分支列都被追踪', () => {
    const g = run(
      `INSERT INTO t_out (id, rmb)
       SELECT id, CASE WHEN amt > 100 THEN amt * rate ELSE amt END FROM t_a;`,
      BASE_DDL,
    );
    expect(findEdge(g, 'T_A::AMT', 'T_OUT::RMB')?.transform).toBe('compute');
    expect(findEdge(g, 'T_A::RATE', 'T_OUT::RMB')?.transform).toBe('compute');
  });

  it('LATERAL VIEW explode 的数组列标为计算', () => {
    const ddl = `CREATE TABLE ev (eid BIGINT, tags ARRAY<STRING>);
                 CREATE TABLE ev_tag (eid BIGINT, tag STRING);`;
    const g = run(
      `INSERT OVERWRITE TABLE ev_tag SELECT eid, t.tag FROM ev LATERAL VIEW explode(tags) t AS tag;`,
      ddl,
    );
    expect(findEdge(g, 'EV::TAGS', 'EV_TAG::TAG')?.transform).toBe('compute');
  });

  it('MERGE 的目标列追溯到源表', () => {
    const ddl = `CREATE TABLE src (id BIGINT, nm STRING); CREATE TABLE tgt (id BIGINT, nm STRING);`;
    const g = run(
      `MERGE INTO tgt t USING src s ON (t.id = s.id)
       WHEN MATCHED THEN UPDATE SET t.nm = s.nm
       WHEN NOT MATCHED THEN INSERT (id, nm) VALUES (s.id, s.nm);`,
      ddl,
    );
    expect(findEdge(g, 'SRC::NM', 'TGT::NM')).toBeDefined();
    expect(findEdge(g, 'SRC::ID', 'TGT::ID')).toBeDefined();
  });
});

describe('影响分析', () => {
  it('修改源列可求全部下游传递闭包', () => {
    const g = run(
      `CREATE VIEW v1 AS SELECT id, amt AS x FROM t_a;
       CREATE VIEW v2 AS SELECT id, x AS y FROM v1;`,
      BASE_DDL,
    );
    const impact = analyzeImpact(g, 'T_A::AMT');
    const all = [...impact.impactedColumns, ...impact.paths.map((p) => p.target)];
    expect(all.some((id) => id.startsWith('V2::Y'))).toBe(true);
    expect(all.some((id) => id.startsWith('V1::X'))).toBe(true);
  });

  it('溯源返回全部上游源列', () => {
    const g = run(
      `INSERT INTO t_out (id, rmb) SELECT id, amt * rate FROM t_a;`,
      BASE_DDL,
    );
    const up = traceUpstream(g, 'T_OUT::RMB');
    expect(up).toContain('T_A::AMT');
    expect(up).toContain('T_A::RATE');
  });

  it('影响路径记录每一跳的加工', () => {
    const g = run(
      `CREATE VIEW v1 AS SELECT id, amt * rate AS x FROM t_a;
       CREATE VIEW rpt_v AS SELECT id, x FROM v1;`,
      BASE_DDL,
    );
    const impact = analyzeImpact(g, 'T_A::AMT');
    const rptPath = impact.paths.find((p) => p.target.startsWith('RPT_V'));
    expect(rptPath).toBeDefined();
    expect(rptPath!.path.length).toBeGreaterThanOrEqual(2);
  });
});

describe('算法变更比对', () => {
  const ddl = `CREATE TABLE s (a DECIMAL(18,2), b DECIMAL(18,2));
               CREATE TABLE r (x DECIMAL(18,2));`;

  it('表达式变化被识别为 expression-changed', () => {
    const oldGraph = buildLineage([
      { name: 'd.sql', content: ddl },
      { name: 'q.sql', content: `INSERT INTO r (x) SELECT a + b FROM s;` },
    ]).graph;
    const newGraph = buildLineage([
      { name: 'd.sql', content: ddl },
      { name: 'q.sql', content: `INSERT INTO r (x) SELECT a * b FROM s;` },
    ]).graph;
    const diff = diffGraphs(oldGraph, newGraph);
    const changed = diff.columnDiffs.find((d) => d.column === 'X' && d.table === 'R');
    expect(changed?.changeType).toBe('expression-changed');
  });

  it('新增列被识别', () => {
    const oldGraph = buildLineage([
      { name: 'd.sql', content: ddl },
      { name: 'q.sql', content: `INSERT INTO r (x) SELECT a FROM s;` },
    ]).graph;
    const ddl2 = `CREATE TABLE s (a DECIMAL(18,2), b DECIMAL(18,2));
                  CREATE TABLE r (x DECIMAL(18,2), y DECIMAL(18,2));`;
    const newGraph = buildLineage([
      { name: 'd.sql', content: ddl2 },
      { name: 'q.sql', content: `INSERT INTO r (x, y) SELECT a, b FROM s;` },
    ]).graph;
    const diff = diffGraphs(oldGraph, newGraph);
    expect(diff.columnDiffs.some((d) => d.column === 'Y' && d.changeType === 'added')).toBe(true);
  });

  it('完全相同的两版无差异', () => {
    const make = () => buildLineage([
      { name: 'd.sql', content: ddl },
      { name: 'q.sql', content: `INSERT INTO r (x) SELECT a + b FROM s;` },
    ]).graph;
    const diff = diffGraphs(make(), make());
    expect(diff.columnDiffs.filter((d) => d.changeType !== 'unchanged')).toHaveLength(0);
  });
});
