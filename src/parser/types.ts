// ============================================================
// 词法 Token 与 AST 类型定义
// ============================================================

export type TokenType =
  | 'keyword'
  | 'identifier'
  | 'number'
  | 'string'
  | 'variable' // :var / ${...} / &var
  | 'op'
  | 'punct'
  | 'comment'
  | 'eof';

export interface Token {
  type: TokenType;
  /** 原始文本(字符串保留引号、标识符保留反引号;比较时用 value) */
  text: string;
  /** 归一化值:关键字大写、标识符去引号大写、字符串去引号原样 */
  value: string;
  /** 关键字子类型标记,便于 parser 直接判断 */
  kw?: string;
  start: number;
  end: number;
  line: number;
}

// ------------------------------------------------------------
// AST
// ------------------------------------------------------------

export type Dialect = 'oracle' | 'hive' | 'generic';

export interface Program {
  statements: Statement[];
  /** 被剥离的 PL/SQL 过程体数量 */
  plsqlBlocks: number;
  /** 识别到的动态 SQL 片段 */
  dynamicSql: DynamicSqlSnippet[];
  /** 词法/语法问题(非致命) */
  issues: ParseIssue[];
}

export type Statement =
  | CreateTableStmt
  | CreateViewStmt
  | InsertStmt
  | SelectStmt
  | MergeStmt
  | UnknownStmt;

export interface UnknownStmt {
  kind: 'unknown';
  text: string;
  startLine: number;
}

export interface ColumnDef {
  name: string;
  dataType?: string;
  /** 列上的内联表达式(如 GENERATED ALWAYS AS) */
  expr?: Expr;
  startLine: number;
}

export interface CreateTableStmt {
  kind: 'createTable';
  orReplace: boolean;
  external: boolean;
  name: TableName;
  /** 列定义;CTAS 时为空 */
  columns: ColumnDef[];
  /** CREATE TABLE ... AS SELECT */
  asQuery?: SelectStmt;
  startLine: number;
}

export interface CreateViewStmt {
  kind: 'createView';
  orReplace: boolean;
  force: boolean;
  name: TableName;
  columnAliases?: string[];
  query: SelectStmt;
  startLine: number;
}

export interface InsertStmt {
  kind: 'insert';
  table: TableName;
  columns?: string[];
  /** INSERT ... SELECT */
  query?: SelectStmt;
  /** 多行 VALUES */
  values?: Expr[][];
  overwrite: boolean;
  partitionSpec?: string[];
  startLine: number;
}

export interface MergeStmt {
  kind: 'merge';
  target: TableName;
  targetAlias?: string;
  source: TableRef;
  /** MERGE 内的 INSERT/UPDATE 部分,统一抽成目标列 -> 表达式 */
  assignments: { column: string; expr: Expr }[];
  startLine: number;
}

export interface TableName {
  parts: string[]; // catalog.schema.table 最多三段
  text: string;
}

export interface SelectStmt {
  kind: 'select';
  distinct: boolean;
  projections: Projection[];
  from: TableRef[];
  where?: Expr;
  groupBy?: Expr[];
  having?: Expr;
  orderBy?: { expr: Expr; desc?: boolean }[];
  limit?: number;
  /** 窗口/ORDER BY 之外的查询级限定 */
  setOps?: SetOp[];
  /** WITH 定义的 CTE:名称 -> SELECT 定义 */
  cteDefs?: Map<string, SelectStmt>;
  startLine: number;
}

export interface SetOp {
  op: 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT' | 'MINUS';
  all: boolean;
  query: SelectStmt;
}

export interface Projection {
  expr: Expr;
  alias?: string;
  /** 显式输出名(alias 优先,否则裸列名) */
  outputName: string;
  star: boolean;
  starQualifier?: string; // t.* 的限定名
  startLine: number;
}

export type TableRef =
  | RelationRef
  | SubqueryRef
  | JoinRef
  | LateralViewRef;

export interface RelationRef {
  kind: 'relation';
  name: TableName;
  alias?: string;
  startLine: number;
}

export interface SubqueryRef {
  kind: 'subquery';
  query: SelectStmt;
  alias?: string;
  columnAliases?: string[];
  startLine: number;
}

export interface JoinRef {
  kind: 'join';
  joinType:
    | 'INNER'
    | 'LEFT'
    | 'RIGHT'
    | 'FULL'
    | 'CROSS'
    | 'SEMI'
    | 'ANTI';
  left: TableRef;
  right: TableRef;
  on?: Expr;
  startLine: number;
}

export interface LateralViewRef {
  kind: 'lateral';
  base: TableRef;
  outer: boolean;
  func: string;
  tableAlias?: string;
  columnAliases: string[];
  startLine: number;
}

// ------------------------------------------------------------
// 表达式
// ------------------------------------------------------------

export type Expr =
  | ColumnRefExpr
  | LiteralExpr
  | FuncCallExpr
  | BinaryExpr
  | UnaryExpr
  | CaseExpr
  | CastExpr
  | SubqueryExpr
  | StarExpr
  | WindowFuncExpr
  | BetweenExpr
  | InExpr
  | ParamExpr
  | TupleExpr;

export interface ColumnRefExpr {
  kind: 'columnRef';
  /** 限定名部分,如 t / schema.table */
  qualifier?: string;
  name: string;
  text: string;
}

export interface LiteralExpr {
  kind: 'literal';
  value: string;
  literalType: 'string' | 'number' | 'boolean' | 'null';
}

export interface FuncCallExpr {
  kind: 'func';
  name: string; // 归一化大写
  args: Expr[];
  distinct: boolean;
  starArg: boolean; // COUNT(*)
  text: string;
}

export interface BinaryExpr {
  kind: 'binary';
  op: string;
  left: Expr;
  right: Expr;
  text: string;
}

export interface UnaryExpr {
  kind: 'unary';
  op: string;
  expr: Expr;
  text: string;
}

export interface CaseExpr {
  kind: 'case';
  operand?: Expr;
  whens: { cond: Expr; result: Expr }[];
  elseResult?: Expr;
  text: string;
}

export interface CastExpr {
  kind: 'cast';
  expr: Expr;
  dataType: string;
  text: string;
}

export interface SubqueryExpr {
  kind: 'subqueryExpr';
  query: SelectStmt;
  text: string;
}

export interface StarExpr {
  kind: 'star';
  qualifier?: string;
  text: string;
}

export interface WindowSpec {
  partitionBy?: Expr[];
  orderBy?: { expr: Expr; desc?: boolean }[];
  frame?: string;
}

export interface WindowFuncExpr {
  kind: 'windowFunc';
  func: FuncCallExpr;
  over: WindowSpec;
  text: string;
}

export interface BetweenExpr {
  kind: 'between';
  expr: Expr;
  negated: boolean;
  low: Expr;
  high: Expr;
  text: string;
}

export interface InExpr {
  kind: 'in';
  expr: Expr;
  negated: boolean;
  list: Expr[];
  subquery?: SelectStmt;
  text: string;
}

export interface ParamExpr {
  kind: 'param';
  name: string;
  text: string;
}

export interface TupleExpr {
  kind: 'tuple';
  items: Expr[];
  text: string;
}

// ------------------------------------------------------------
// 解析期问题
// ------------------------------------------------------------

export type IssueSeverity = 'error' | 'warn' | 'info';

export interface ParseIssue {
  code:
    | 'PARSE_ERROR'
    | 'DYNAMIC_SQL'
    | 'UNKNOWN_TABLE'
    | 'AMBIGUOUS_COLUMN'
    | 'UNRESOLVED_COLUMN'
    | 'STAR_UNKNOWN_SCHEMA'
    | 'UNSUPPORTED_SYNTAX'
    | 'UNRESOLVED_DYNAMIC';
  message: string;
  severity: IssueSeverity;
  file?: string;
  startLine?: number;
  snippet?: string;
}

export interface DynamicSqlSnippet {
  file?: string;
  startLine: number;
  /** 拼串前的原始代码 */
  raw: string;
  /** 变量替换后的可解析 SQL(识别成功时) */
  resolvedSql?: string;
  resolved: boolean;
  reason?: string;
}
