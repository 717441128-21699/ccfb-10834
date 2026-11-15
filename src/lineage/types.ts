// ============================================================
// 血缘图谱数据模型
// ============================================================

export type TransformType =
  | 'direct' // 原样搬运:t.a -> a
  | 'compute' // 参与计算:a + b、函数、CASE、CAST 等
  | 'aggregate' // 聚合函数
  | 'window' // 窗口函数
  | 'constant' // 常量/字面量输出
  | 'star'; // 星号展开产生

export interface ColumnNode {
  /** 全局唯一 id: 表名::列名 */
  id: string;
  table: string;
  column: string;
  /** 来源脚本文件 */
  file?: string;
  /** 该列由哪个语句产出(DDL / 视图 / INSERT / CTAS) */
  producedBy?: string;
  dataType?: string;
  /** 物理表列(DDL 注册)还是中间产出 */
  isPhysical: boolean;
  isReport?: boolean;
}

export interface LineageEdge {
  id: string;
  /** 上游列 id */
  source: string;
  /** 下游列 id */
  target: string;
  transform: TransformType;
  /** 参与的表达式描述,如 "amount * rate" */
  expression?: string;
  /** 加工函数名,如 SUM / CASE / SUBSTR */
  func?: string;
  file?: string;
  /** 同一条产出语句内的边序号,用于路径展示 */
  seq?: number;
}

export interface TableNode {
  name: string;
  columns: string[];
  file?: string;
  /** table / view / cte / report */
  kind: 'table' | 'view' | 'cte' | 'report' | 'unknown';
  dialect?: string;
}

export interface LineageGraph {
  columns: Map<string, ColumnNode>;
  tables: Map<string, TableNode>;
  edges: LineageEdge[];
  issues: GraphIssue[];
  /** 未识别/已识别的动态 SQL */
  dynamicSql: DynamicSqlRecord[];
}

export interface GraphIssue {
  code: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  file?: string;
  startLine?: number;
  snippet?: string;
}

export interface DynamicSqlRecord {
  file?: string;
  startLine: number;
  raw: string;
  resolved: boolean;
  resolvedSql?: string;
  reason?: string;
}

/** 影响分析结果 */
export interface ImpactResult {
  root: string;
  /** 受波及的下游列(去重,含传递闭包) */
  impactedColumns: string[];
  /** 受波及的报表列 */
  reportColumns: string[];
  /** 从 root 到每个受影响列的加工路径 */
  paths: { target: string; path: LineageEdge[] }[];
}

/** 两版脚本的列比对结果 */
export interface ColumnDiff {
  table: string;
  column: string;
  changeType: 'added' | 'removed' | 'expression-changed' | 'unchanged' | 'upstream-changed';
  oldExpression?: string;
  newExpression?: string;
  oldUpstream: string[];
  newUpstream: string[];
}

export interface DiffResult {
  addedTables: string[];
  removedTables: string[];
  columnDiffs: ColumnDiff[];
}
