import {
  CreateTableStmt,
  CreateViewStmt,
  Dialect,
  Expr,
  InsertStmt,
  MergeStmt,
  Program,
  SelectStmt,
  Statement,
  TableRef,
} from '../parser/types';
import {
  GraphIssue,
  LineageGraph,
  TableNode,
  TransformType,
} from './types';
import { collectColumnRefs, isAggregateExpr, isPassthrough, serializeExpr, topFuncLabel } from './expr-tools';

interface ResolvedColumn {
  id: string;
  table: string;
  column: string;
}

interface InputScope {
  aliasToTable: Map<string, string>;
  schemas: Map<string, string[]>;
  columnIndex: Map<string, ResolvedColumn[]>;
}

interface OutputColumn {
  name: string;
  expr: Expr;
  star: boolean;
}

interface SelectResult {
  outputs: OutputColumn[];
  /** 本次 SELECT 输出列所在的(合成)表名 */
  targetTable: string;
}

export class LineageAnalyzer {
  private graph: LineageGraph = {
    columns: new Map(),
    tables: new Map(),
    edges: [],
    issues: [],
    dynamicSql: [],
  };
  private edgeSeq = 0;
  private synthSeq = 0;
  private file?: string;
  private currentLine?: number;

  analyze(programs: { program: Program; file: string; dialect: Dialect }[]): LineageGraph {
    // Pass 1: 注册 DDL 物理 schema
    for (const { program, file } of programs) {
      for (const stmt of program.statements) {
        if (stmt.kind === 'createTable') {
          this.registerTable(stmt.name.text, stmt.columns.map((c) => c.name), file, 'table');
          this.registerColumns(stmt.name.text, stmt.columns.map((c) => ({ name: c.name, dataType: c.dataType })), file);
        }
        if (stmt.kind === 'createView') {
          this.registerTable(stmt.name.text, [], file, 'view');
        }
      }
      for (const d of program.dynamicSql) {
        this.graph.dynamicSql.push({ ...d });
      }
    }

    // Pass 2: 逐语句构建血缘
    for (const { program, file } of programs) {
      this.file = file;
      for (const stmt of program.statements) {
        this.currentLine = stmt.startLine;
        try {
          this.processStatement(stmt);
        } catch (e) {
          this.issue('PARSE_ERROR', `血缘分析失败:${e instanceof Error ? e.message : String(e)}`, 'error', file, stmt.startLine);
        }
      }
      for (const iss of program.issues) {
        this.graph.issues.push({ ...iss, file });
      }
    }

    return this.graph;
  }

  // ---------------------------------------------------------
  private registerTable(name: string, columns: string[], file: string, kind: TableNode['kind']): void {
    const existing = this.graph.tables.get(name);
    if (existing) {
      const merged = new Set([...existing.columns, ...columns]);
      existing.columns = [...merged];
      if (columns.length) existing.kind = kind;
      return;
    }
    this.graph.tables.set(name, { name, columns: [...columns], file, kind });
  }

  private registerColumns(table: string, cols: { name: string; dataType?: string }[], file: string): void {
    for (const c of cols) {
      const id = this.colId(table, c.name);
      if (!this.graph.columns.has(id)) {
        this.graph.columns.set(id, { id, table, column: c.name, file, dataType: c.dataType, isPhysical: true });
      }
    }
  }

  private colId(table: string, column: string): string {
    return `${table}::${column}`;
  }

  private ensureColumn(table: string, column: string, isPhysical = false): string {
    const id = this.colId(table, column);
    if (!this.graph.columns.has(id)) {
      this.graph.columns.set(id, { id, table, column, file: this.file, isPhysical });
      const t = this.graph.tables.get(table);
      if (t && !t.columns.includes(column)) t.columns.push(column);
      else if (!t) this.graph.tables.set(table, { name: table, columns: [column], file: this.file, kind: 'unknown' });
    }
    return id;
  }

  private issue(code: GraphIssue['code'], message: string, severity: GraphIssue['severity'], file?: string, startLine?: number, snippet?: string): void {
    this.graph.issues.push({ code, message, severity, file, startLine, snippet });
  }

  private newSynthTable(prefix: string): string {
    return `__${prefix}_${this.synthSeq++}`;
  }

  // ---------------------------------------------------------
  private processStatement(stmt: Statement): void {
    switch (stmt.kind) {
      case 'createTable':
        this.processCreateTable(stmt);
        break;
      case 'createView':
        this.processCreateView(stmt);
        break;
      case 'insert':
        this.processInsert(stmt);
        break;
      case 'merge':
        this.processMerge(stmt);
        break;
      case 'select':
        this.analyzeSelect(stmt, new Map());
        break;
      case 'unknown':
        break;
    }
  }

  private processCreateTable(stmt: CreateTableStmt): void {
    const table = stmt.name.text;
    for (const col of stmt.columns) {
      const targetId = this.ensureColumn(table, col.name, true);
      if (col.expr) {
        // 生成列引用同表其他列,用本表 DDL 构建自引用作用域
        const scope = this.selfScope(table);
        this.emitExprEdges(col.expr, targetId, scope);
      }
    }
    if (stmt.asQuery) {
      const { outputs } = this.analyzeSelect(stmt.asQuery, new Map());
      this.bindOutputs(outputs, table);
    }
  }

  private selfScope(table: string): InputScope {
    const aliasToTable = new Map<string, string>([[table.toUpperCase(), table]]);
    const cols = this.graph.tables.get(table)?.columns ?? [];
    const schemas = new Map<string, string[]>([[table, cols]]);
    const columnIndex = new Map<string, ResolvedColumn[]>();
    for (const c of cols) {
      columnIndex.set(c.toUpperCase(), [{ id: this.colId(table, c), table, column: c }]);
    }
    return { aliasToTable, schemas, columnIndex };
  }

  private processCreateView(stmt: CreateViewStmt): void {
    const table = stmt.name.text;
    const { outputs } = this.analyzeSelect(stmt.query, new Map());
    const finalOutputs = stmt.columnAliases
      ? outputs.map((o, idx) => ({ ...o, name: stmt.columnAliases![idx] ?? o.name }))
      : outputs;
    this.registerTable(table, finalOutputs.map((o) => o.name), this.file!, 'view');
    this.bindOutputs(finalOutputs, table);
  }

  private processInsert(stmt: InsertStmt): void {
    const table = stmt.table.text;
    if (stmt.query) {
      const { outputs } = this.analyzeSelect(stmt.query, new Map());
      let targetNames: string[];
      if (stmt.columns?.length) {
        targetNames = stmt.columns;
      } else {
        const targetSchema = this.graph.tables.get(table)?.columns ?? outputs.map((o) => o.name);
        targetNames = targetSchema.slice(0, outputs.length);
      }
      outputs.forEach((out, idx) => {
        const targetCol = targetNames[idx];
        if (!targetCol) return;
        const targetId = this.ensureColumn(table, targetCol, true);
        this.rebindOutput(out, targetId);
      });
      stmt.partitionSpec?.forEach((p) => this.ensureColumn(table, p, true));
    } else if (stmt.values) {
      const targetSchema = this.graph.tables.get(table)?.columns ?? [];
      for (const row of stmt.values) {
        row.forEach((expr, idx) => {
          const targetCol = stmt.columns?.[idx] ?? targetSchema[idx];
          if (!targetCol) return;
          const targetId = this.ensureColumn(table, targetCol, true);
          this.emitExprEdges(expr, targetId, this.emptyScope());
        });
      }
    }
  }

  private processMerge(stmt: MergeStmt): void {
    const table = stmt.target.text;
    const scope = this.buildScope([stmt.source], new Map());
    for (const a of stmt.assignments) {
      const targetId = this.ensureColumn(table, a.column, true);
      this.emitExprEdges(a.expr, targetId, scope);
    }
  }

  /** 把合成表上的输出列重新绑定到真实目标表 */
  private bindOutputs(outputs: OutputColumn[], table: string): void {
    for (const out of outputs) {
      const targetId = this.ensureColumn(table, out.name, table.startsWith('__') === false);
      this.rebindOutput(out, targetId);
    }
  }

  private rebindOutput(out: OutputColumn, newTargetId: string): void {
    // out 自身的边在 analyzeSelect 内已指向合成列;这里把"合成列 -> 目标列"补一条 direct 边
    // 合成列 id 记录在 output 的扩展字段
    const synthId = (out as OutputColumn & { __synthId?: string }).__synthId;
    if (synthId && synthId !== newTargetId) {
      this.addEdge(synthId, newTargetId, 'direct');
    }
  }

  // ---------------------------------------------------------
  // SELECT 分析
  // ---------------------------------------------------------
  private analyzeSelect(select: SelectStmt, outerCtes: Map<string, string>): SelectResult {
    // 先物化本层 CTE:cte 名 -> 合成表名(后定义的 CTE 可引用先定义的)
    const cteTables = new Map(outerCtes);
    const cteDefs = this.extractCteDefs(select);
    for (const [name, cteStmt] of cteDefs) {
      const { outputs, targetTable } = this.analyzeSelect(cteStmt, cteTables);
      this.registerTable(targetTable, outputs.map((o) => o.name), this.file ?? '', 'cte');
      cteTables.set(name, targetTable);
    }
    const targetTable = this.newSynthTable('SEL');
    const scope = this.buildScope(select.from, cteTables);

    let outputs: OutputColumn[] = [];
    for (const proj of select.projections) {
      if (proj.star) {
        outputs.push(...this.expandStar(proj.starQualifier, scope));
      } else {
        outputs.push({ name: proj.outputName, expr: proj.expr, star: false });
      }
    }

    outputs.forEach((out) => {
      const targetId = this.ensureColumn(targetTable, out.name);
      (out as OutputColumn & { __synthId?: string }).__synthId = targetId;
      this.emitExprEdges(out.expr, targetId, scope);
    });

    // 集合运算:右侧输出汇合到左侧同位置列
    if (select.setOps) {
      for (const setOp of select.setOps) {
        const right = this.analyzeSelect(setOp.query, cteTables);
        right.outputs.forEach((r, idx) => {
          const leftName = outputs[idx]?.name;
          if (!leftName) return;
          const rightId = (r as OutputColumn & { __synthId?: string }).__synthId;
          const leftTarget = this.colId(targetTable, leftName);
          if (rightId) this.addEdge(rightId, leftTarget, 'direct', undefined, setOp.op);
        });
      }
    }

    return { outputs, targetTable };
  }

  /** parser 已把 CTE 定义放在 SelectStmt 上没有单独字段;这里借助 from 无法拿到,
   *  所以 CTE 定义通过 parser 的 cteScope 暴露 —— 在 parser 里我们改用附加字段。 */
  private extractCteDefs(select: SelectStmt): Map<string, SelectStmt> {
    const defs = (select as SelectStmt & { cteDefs?: Map<string, SelectStmt> }).cteDefs;
    return defs ?? new Map();
  }

  private emptyScope(): InputScope {
    return { aliasToTable: new Map(), schemas: new Map(), columnIndex: new Map() };
  }

  private expandStar(qualifier: string | undefined, scope: InputScope): OutputColumn[] {
    const result: OutputColumn[] = [];
    if (qualifier) {
      const table = scope.aliasToTable.get(qualifier.toUpperCase());
      if (!table) {
        this.issue('STAR_UNKNOWN_SCHEMA', `星号限定名 ${qualifier} 无法解析`, 'warn', this.file, this.currentLine);
        return result;
      }
      const cols = scope.schemas.get(table);
      if (!cols?.length) {
        this.issue('STAR_UNKNOWN_SCHEMA', `表 ${table} 缺少 DDL,星号无法展开`, 'warn', this.file, this.currentLine);
        return result;
      }
      for (const c of cols) {
        result.push({ name: c, star: true, expr: { kind: 'columnRef', qualifier, name: c, text: `${qualifier}.${c}` } });
      }
      return result;
    }
    for (const [table, cols] of scope.schemas) {
      const alias = this.findAliasForTable(scope, table);
      for (const c of cols) {
        result.push({
          name: c,
          star: true,
          expr: { kind: 'columnRef', qualifier: alias, name: c, text: alias ? `${alias}.${c}` : c },
        });
      }
    }
    if (!result.length) this.issue('STAR_UNKNOWN_SCHEMA', '所有来源表都缺少 DDL,星号无法展开', 'warn', this.file, this.currentLine);
    return result;
  }

  private findAliasForTable(scope: InputScope, table: string): string | undefined {
    for (const [alias, t] of scope.aliasToTable) if (t === table) return alias;
    return undefined;
  }

  // ---------------------------------------------------------
  private buildScope(refs: TableRef[], cteTables: Map<string, string>): InputScope {
    const aliasToTable = new Map<string, string>();
    const schemas = new Map<string, string[]>();
    const columnIndex = new Map<string, ResolvedColumn[]>();
    let counter = 0;

    const addRelation = (tableName: string, alias: string | undefined, cols: string[]) => {
      const aliasKey = (alias ?? tableName).toUpperCase();
      aliasToTable.set(aliasKey, tableName);
      schemas.set(tableName, cols);
      for (const c of cols) {
        const list = columnIndex.get(c.toUpperCase()) ?? [];
        list.push({ id: this.colId(tableName, c), table: tableName, column: c });
        columnIndex.set(c.toUpperCase(), list);
      }
    };

    const walk = (ref: TableRef): void => {
      switch (ref.kind) {
        case 'relation': {
          const name = ref.name.text;
          const cteTarget = cteTables.get(name.toUpperCase());
          if (cteTarget) {
            const cols = this.graph.tables.get(cteTarget)?.columns ?? [];
            addRelation(cteTarget, ref.alias ?? name, cols);
            aliasToTable.set(name.toUpperCase(), cteTarget);
          } else {
            const cols = this.graph.tables.get(name)?.columns ?? [];
            if (!this.graph.tables.has(name)) {
              this.issue('UNKNOWN_TABLE', `表或视图 ${name} 没有对应的 DDL/定义`, 'warn', this.file, this.currentLine);
              this.graph.tables.set(name, { name, columns: [], file: this.file, kind: 'unknown' });
            }
            addRelation(name, ref.alias, cols);
          }
          break;
        }
        case 'subquery': {
          const { outputs, targetTable } = this.analyzeSelect(ref.query, cteTables);
          this.registerTable(targetTable, outputs.map((o) => o.name), this.file ?? '', 'cte');
          const synAlias = ref.alias ?? `SUB${counter++}`;
          addRelation(targetTable, synAlias, outputs.map((o) => o.name));
          break;
        }
        case 'join':
          walk(ref.left);
          walk(ref.right);
          break;
        case 'lateral': {
          walk(ref.base);
          const synName = this.newSynthTable('LAT');
          ref.columnAliases.forEach((c) => this.ensureColumn(synName, c));
          addRelation(synName, ref.tableAlias, ref.columnAliases);
          // lateral explode 的输入参数列补边到产出列
          const args = (ref as TableRef & { args?: Expr[] }).args ?? [];
          for (const arg of args) {
            const refs = collectColumnRefs(arg);
            for (const r of refs) {
              const resolved = this.resolveColumn(r, { aliasToTable, schemas, columnIndex });
              if (resolved) {
                for (const outCol of ref.columnAliases) {
                  this.addEdge(resolved.id, this.colId(synName, outCol), 'compute', `LATERAL ${ref.func}`, ref.func);
                }
              }
            }
          }
          break;
        }
      }
    };

    refs.forEach(walk);
    return { aliasToTable, schemas, columnIndex };
  }

  // ---------------------------------------------------------
  /** 静默解析:失败不产生 issue,用于相关子查询的内外作用域试探 */
  private tryResolve(
    ref: { qualifier?: string; name: string; text: string },
    scope: InputScope,
  ): ResolvedColumn | undefined {
    if (ref.qualifier) {
      const q = ref.qualifier.toUpperCase();
      let table = scope.aliasToTable.get(q) ?? scope.aliasToTable.get(q.split('.').pop()!);
      if (!table) return undefined;
      this.ensureColumn(table, ref.name);
      return { id: this.colId(table, ref.name), table, column: ref.name };
    }
    const candidates = scope.columnIndex.get(ref.name.toUpperCase());
    return candidates?.[0];
  }

  private resolveColumn(
    ref: { qualifier?: string; name: string; text: string },
    scope: InputScope,
  ): ResolvedColumn | undefined {
    const found = this.tryResolve(ref, scope);
    if (found) return found;
    if (ref.qualifier) {
      this.issue('UNRESOLVED_COLUMN', `限定名 ${ref.text} 对应的表不在作用域内`, 'warn', this.file, this.currentLine);
      return undefined;
    }
    this.issue('UNRESOLVED_COLUMN', `列 ${ref.name} 在当前作用域无法解析`, 'warn', this.file, this.currentLine);
    return undefined;
  }

  // ---------------------------------------------------------
  private emitExprEdges(expr: Expr, targetId: string, scope: InputScope): void {
    // 先递归处理表达式内嵌的标量子查询:用子查询自己的 FROM 作用域解析其内部列
    this.emitSubqueryEdges(expr, targetId, scope);

    // 窗口函数:分区/排序列单独打 window 边
    if (expr.kind === 'windowFunc') {
      const spec = expr.over;
      const specExprs = [
        ...(spec.partitionBy ?? []),
        ...(spec.orderBy?.map((o) => o.expr) ?? []),
      ];
      for (const se of specExprs) {
        for (const ref of collectColumnRefs(se)) {
          const resolved = this.resolveColumn(ref, scope);
          if (resolved) this.addEdge(resolved.id, targetId, 'window', serializeExpr(expr), expr.func.name);
        }
      }
    }

    const refs = collectColumnRefs(expr);
    const expression = serializeExpr(expr);

    if (!refs.length) {
      if (expr.kind === 'literal' || expr.kind === 'param') {
        this.addEdge('', targetId, 'constant', expression);
      }
      return;
    }

    let transform: TransformType;
    if (isPassthrough(expr) && refs.length === 1) transform = 'direct';
    else if (expr.kind === 'windowFunc') transform = 'window';
    else if (isAggregateExpr(expr)) transform = 'aggregate';
    else transform = 'compute';
    const func = topFuncLabel(expr);

    const seen = new Set<string>();
    for (const ref of refs) {
      const resolved = this.resolveColumn(ref, scope);
      if (!resolved || seen.has(resolved.id)) continue;
      seen.add(resolved.id);
      this.addEdge(resolved.id, targetId, transform, expression, func);
    }
  }

  /** 处理表达式里的标量子查询,把其内部引用的物理列直接连到当前目标列 */
  private emitSubqueryEdges(expr: Expr, targetId: string, outerScope: InputScope): void {
    const walk = (e: Expr): void => {
      if (e.kind === 'subqueryExpr') {
        const { outputs, targetTable } = this.analyzeSelect(e.query, new Map());
        // 子查询输出(通常单列)合成列 -> 当前目标
        for (const out of outputs) {
          const synthId = (out as OutputColumn & { __synthId?: string }).__synthId ?? this.colId(targetTable, out.name);
          this.addEdge(synthId, targetId, 'aggregate', '(SCALAR SUBQUERY)');
        }
        // 相关子查询的 WHERE:能在子查询自身作用域解析的归子查询,否则按外层关联列处理
        if (e.query.where) {
          const subScope = this.buildScope(e.query.from, new Map());
          for (const ref of collectColumnRefs(e.query.where)) {
            const inner = this.tryResolve(ref, subScope);
            if (inner) {
              this.addEdge(inner.id, targetId, 'aggregate', '(SUBQUERY FILTER)');
            } else {
              const outer = this.resolveColumn(ref, outerScope);
              if (outer) this.addEdge(outer.id, targetId, 'compute', '(CORRELATED SUBQUERY)');
            }
          }
        }
        e.query.projections.forEach((p) => walk(p.expr));
        return;
      }
      switch (e.kind) {
        case 'binary': walk(e.left); walk(e.right); break;
        case 'unary': walk(e.expr); break;
        case 'func': e.args.forEach(walk); break;
        case 'case':
          if (e.operand) walk(e.operand);
          e.whens.forEach((w) => { walk(w.cond); walk(w.result); });
          if (e.elseResult) walk(e.elseResult);
          break;
        case 'cast': walk(e.expr); break;
        case 'windowFunc': e.func.args.forEach(walk); break;
        case 'between': walk(e.expr); walk(e.low); walk(e.high); break;
        case 'in':
          walk(e.expr);
          e.list.forEach(walk);
          if (e.subquery) this.analyzeSelect(e.subquery, new Map());
          break;
        case 'tuple': e.items.forEach(walk); break;
      }
    };
    walk(expr);
  }

  private addEdge(source: string, target: string, transform: TransformType, expression?: string, func?: string): void {
    const dup = this.graph.edges.find(
      (e) => e.source === source && e.target === target && e.transform === transform && e.expression === expression,
    );
    if (dup) return;
    this.graph.edges.push({
      id: `e${this.edgeSeq++}`,
      source,
      target,
      transform,
      expression,
      func,
      file: this.file,
      seq: this.edgeSeq,
    });
  }
}
