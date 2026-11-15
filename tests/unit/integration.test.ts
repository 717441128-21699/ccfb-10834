import { describe, it, expect } from 'vitest';
import { buildLineage, detectDialect, parseFile } from '../../src/engine';
import { physicalLineage, analyzeImpact } from '../../src/lineage/impact';

describe('引擎端到端集成', () => {
  it('方言自动识别:Oracle 与 Hive 特征', () => {
    expect(detectDialect('SELECT * FROM t WHERE x = NVL(a,1)')).toBe('oracle');
    expect(detectDialect('INSERT OVERWRITE TABLE t SELECT * FROM s LATERAL VIEW explode(a) x AS y')).toBe('hive');
  });

  it('多文件管道:DDL -> 视图 -> 报表 全链路可追溯', () => {
    const result = buildLineage([
      { name: 'ddl.sql', content: `CREATE TABLE src (id BIGINT, amt DECIMAL(18,2));
                                    CREATE TABLE rpt (id BIGINT, total DECIMAL(18,2));` },
      { name: 'view.sql', content: `CREATE VIEW v_mid AS SELECT id, amt AS mid_amt FROM src;` },
      { name: 'rpt.sql', content: `INSERT INTO rpt (id, total) SELECT id, SUM(mid_amt) FROM v_mid GROUP BY id;` },
    ]);
    expect(result.graph.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const edges = physicalLineage(result.graph);
    // 报表列一路追溯到物理源
    expect(edges.some((e) => e.source === 'SRC::AMT' && e.target === 'RPT::TOTAL' && e.transform === 'aggregate')).toBe(true);
    expect(edges.some((e) => e.source === 'SRC::ID' && e.target === 'RPT::ID')).toBe(true);
  });

  it('影响分析在多跳链路上返回完整报表清单', () => {
    const result = buildLineage([
      { name: 'ddl.sql', content: `CREATE TABLE src (id BIGINT, amt DECIMAL(18,2));
                                    CREATE TABLE rpt (id BIGINT, total DECIMAL(18,2));` },
      { name: 'v1.sql', content: `CREATE VIEW v1 AS SELECT id, amt AS a FROM src;` },
      { name: 'v2.sql', content: `CREATE VIEW v2 AS SELECT id, a AS b FROM v1;` },
      { name: 'rpt.sql', content: `INSERT INTO rpt (id, total) SELECT id, b FROM v2;` },
    ]);
    const impact = analyzeImpact(result.graph, 'SRC::AMT');
    expect(impact.impactedColumns.some((id) => id.startsWith('RPT::TOTAL'))).toBe(true);
    const rptPath = impact.paths.find((p) => p.target.startsWith('RPT::TOTAL'));
    expect(rptPath!.path.length).toBeGreaterThanOrEqual(3);
  });

  it('PL/SQL 动态 SQL:可还原的纳入血缘,不可还原的单列', () => {
    const parsed = parseFile({
      name: 'proc.sql',
      dialect: 'oracle',
      content: `
CREATE OR REPLACE PROCEDURE p(x IN VARCHAR2)
AS
  v_sql VARCHAR2(4000);
BEGIN
  v_sql := 'INSERT INTO rpt(id, total) SELECT id, amt FROM src WHERE region = ' || x;
  EXECUTE IMMEDIATE v_sql;
END;
/`,
    });
    const dyn = parsed.program.dynamicSql;
    expect(dyn).toHaveLength(1);
    expect(dyn[0].resolved).toBe(true);
    expect(dyn[0].resolvedSql).toContain('INSERT INTO rpt');
    // 还原出的 INSERT 已进入语句列表
    expect(parsed.program.statements.some((s) => s.kind === 'insert')).toBe(true);
  });

  it('完全由变量构成的动态 SQL 被标记为待人工确认', () => {
    const parsed = parseFile({
      name: 'dark.sql',
      dialect: 'oracle',
      content: `
CREATE OR REPLACE PROCEDURE p
AS
  v_sql VARCHAR2(4000);
BEGIN
  v_sql := load_config('key');
  EXECUTE IMMEDIATE v_sql;
END;
/`,
    });
    const dyn = parsed.program.dynamicSql;
    expect(dyn).toHaveLength(1);
    expect(dyn[0].resolved).toBe(false);
  });

  it('常量输出产生 constant 边且不产生虚假列引用', () => {
    const result = buildLineage([
      { name: 'ddl.sql', content: `CREATE TABLE s (id BIGINT); CREATE TABLE r (id BIGINT, flag BIGINT);` },
      { name: 'q.sql', content: `INSERT INTO r (id, flag) SELECT id, 1 AS flag FROM s;` },
    ]);
    const constEdge = result.graph.edges.find((e) => e.target.endsWith('::FLAG') && e.transform === 'constant');
    expect(constEdge).toBeDefined();
    expect(constEdge?.source).toBe('');
  });
});
