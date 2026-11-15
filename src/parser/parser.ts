import { tokenize } from './tokenizer';
import {
  BetweenExpr,
  CaseExpr,
  CastExpr,
  ColumnRefExpr,
  CreateTableStmt,
  CreateViewStmt,
  Dialect,
  Expr,
  FuncCallExpr,
  InExpr,
  InsertStmt,
  JoinRef,
  LateralViewRef,
  MergeStmt,
  ParamExpr,
  ParseIssue,
  Program,
  Projection,
  SelectStmt,
  SetOp,
  StarExpr,
  Statement,
  SubqueryExpr,
  TableName,
  TableRef,
  Token,
  TupleExpr,
  WindowFuncExpr,
} from './types';

const SET_OPS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS']);
const JOIN_TYPES = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'SEMI', 'ANTI']);
const DATA_TYPES = new Set([
  'DECIMAL', 'NUMBER', 'VARCHAR', 'VARCHAR2', 'CHAR', 'DATE', 'TIMESTAMP',
  'INT', 'INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT', 'STRING', 'BOOLEAN',
  'BINARY', 'ARRAY', 'MAP', 'STRUCT',
]);

export class Parser {
  private tokens: Token[] = [];
  private pos = 0;
  private issues: ParseIssue[] = [];

  parseProgram(sql: string, _dialect: Dialect = 'generic'): Program {
    const { tokens, errors } = tokenize(sql);
    this.tokens = tokens;
    this.pos = 0;
    this.issues = errors.map((e) => ({
      code: 'PARSE_ERROR',
      message: e.message,
      severity: 'error',
      startLine: e.line,
    }));

    const statements: Statement[] = [];
    while (!this.atEnd()) {
      try {
        const startLine = this.peek().line;
        const kw = this.peek().value;
        if (kw === 'WITH') {
          // 前瞻 WITH 后接的是 INSERT 还是 SELECT
          if (this.startsWithWithInsert()) statements.push(this.parseInsert(startLine));
          else statements.push(this.parseSelect(startLine));
        } else if (kw === 'SELECT') {
          statements.push(this.parseSelect(startLine));
        } else if (kw === 'CREATE') {
          statements.push(this.parseCreate(startLine));
        } else if (kw === 'INSERT') {
          statements.push(this.parseInsert(startLine));
        } else if (kw === 'MERGE') {
          statements.push(this.parseMerge(startLine));
        } else {
          this.skipStatement();
        }
      } catch (e) {
        this.issues.push({
          code: 'PARSE_ERROR',
          message: e instanceof Error ? e.message : String(e),
          severity: 'error',
          startLine: this.peek().line,
        });
        this.skipStatement();
      }
    }

    return {
      statements,
      plsqlBlocks: 0,
      dynamicSql: [],
      issues: this.issues,
    };
  }

  getIssues(): ParseIssue[] {
    return this.issues;
  }

  /** 前瞻:当前 WITH 子句之后是否为 INSERT */
  private startsWithWithInsert(): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (t.type === 'punct' && t.value === '(') depth++;
      if (t.type === 'punct' && t.value === ')') depth--;
      if (depth === 0 && t.type === 'keyword' && t.value === 'INSERT') return true;
      if (depth === 0 && t.type === 'keyword' && t.value === 'SELECT') return false;
    }
    return false;
  }

  // ---------------------------------------------------------
  // token 导航
  // ---------------------------------------------------------
  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private atEnd(): boolean {
    return this.peek().type === 'eof';
  }

  private isKw(...kws: string[]): boolean {
    const t = this.peek();
    return t.type === 'keyword' && kws.includes(t.value);
  }

  private matchKw(...kws: string[]): boolean {
    if (this.isKw(...kws)) {
      this.next();
      return true;
    }
    return false;
  }

  private expectKw(kw: string): Token {
    if (!this.isKw(kw)) {
      throw new Error(`期望关键字 ${kw},实际为 "${this.peek().text || this.peek().type}" (行 ${this.peek().line})`);
    }
    return this.next();
  }

  private isPunct(p: string): boolean {
    return this.peek().type === 'punct' && this.peek().value === p;
  }

  private matchPunct(p: string): boolean {
    if (this.isPunct(p)) {
      this.next();
      return true;
    }
    return false;
  }

  private expectPunct(p: string): Token {
    if (!this.isPunct(p)) {
      throw new Error(`期望 "${p}",实际为 "${this.peek().text || this.peek().type}" (行 ${this.peek().line})`);
    }
    return this.next();
  }

  private matchOp(op: string): boolean {
    if (this.peek().type === 'op' && this.peek().value === op) {
      this.next();
      return true;
    }
    return false;
  }

  /** 吞掉当前语句(到下一个 SELECT/CREATE/INSERT/MERGE/WITH 起点),容错恢复 */
  private skipStatement(): void {
    const startKws = new Set(['SELECT', 'CREATE', 'INSERT', 'MERGE', 'WITH']);
    while (!this.atEnd()) {
      const t = this.next();
      if (t.type === 'keyword' && startKws.has(t.value)) {
        this.pos--;
        break;
      }
    }
  }

  // ---------------------------------------------------------
  // 名称
  // ---------------------------------------------------------
  private parseTableName(): TableName {
    const parts: string[] = [this.parseIdentifier()];
    while (this.isPunct('.')) {
      this.next();
      parts.push(this.parseIdentifier());
    }
    return { parts, text: parts.join('.') };
  }

  private parseIdentifier(): string {
    const t = this.peek();
    if (t.type === 'identifier') {
      this.next();
      return t.value;
    }
    // 关键字被当名字用的常见情况(如 "date" 列)
    if (t.type === 'keyword' && !DATA_TYPES.has(t.value) && !SET_OPS.has(t.value)) {
      this.next();
      return t.value;
    }
    throw new Error(`期望标识符,实际为 "${t.text || t.type}" (行 ${t.line})`);
  }

  /** 解析可能的别名:AS name 或裸 name(排除关键字) */
  private parseAlias(): string | undefined {
    if (this.matchKw('AS')) return this.parseIdentifier();
    const t = this.peek();
    const reserved = new Set([
      'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT',
      'EXCEPT', 'MINUS', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'ON',
      'WHEN', 'THEN', 'ELSE', 'END', 'OVER', 'AND', 'OR', 'IN', 'IS', 'LIKE',
      'BETWEEN', 'NOT', 'ASC', 'DESC', 'LATERAL', 'WINDOW', 'QUALIFY',
    ]);
    if (t.type === 'identifier' || (t.type === 'keyword' && !reserved.has(t.value) && !DATA_TYPES.has(t.value))) {
      this.next();
      return t.value;
    }
    return undefined;
  }

  // ---------------------------------------------------------
  // CREATE
  // ---------------------------------------------------------
  private parseCreate(startLine: number): CreateTableStmt | CreateViewStmt {
    this.expectKw('CREATE');
    const orReplace = this.matchKw('OR') && (this.expectKw('REPLACE'), true);
    const force = this.matchKw('FORCE');
    this.matchKw('EXTERNAL'); // CREATE EXTERNAL TABLE
    const isView = this.isKw('VIEW');
    this.next(); // TABLE / VIEW

    if (isView) {
      const name = this.parseTableName();
      let columnAliases: string[] | undefined;
      if (this.matchPunct('(')) {
        columnAliases = [this.parseIdentifier()];
        while (this.matchPunct(',')) columnAliases.push(this.parseIdentifier());
        this.expectPunct(')');
      }
      this.matchKw('AS');
      const query = this.parseSelect(startLine);
      return { kind: 'createView', orReplace, force, name, columnAliases, query, startLine };
    }

    const external = false;
    this.matchKw('IF');
    this.matchKw('NOT');
    this.matchKw('EXISTS');
    const name = this.parseTableName();

    // CTAS
    if (this.isKw('AS')) {
      this.next();
      const asQuery = this.parseSelect(startLine);
      return { kind: 'createTable', orReplace, external, name, columns: [], asQuery, startLine };
    }

    this.expectPunct('(');
    const columns = this.parseColumnDefs();
    this.expectPunct(')');
    // 吞掉表级属性:STORED AS / TBLPROPERTIES / PARTITIONED BY ...
    this.skipTableTail();
    return { kind: 'createTable', orReplace, external, name, columns, startLine };
  }

  private parseColumnDefs() {
    const columns: CreateTableStmt['columns'] = [];
    do {
      if (this.isKw('CONSTRAINT', 'PRIMARY', 'KEY', 'CHECK', 'FOREIGN', 'UNIQUE')) {
        this.skipParenGroup();
        continue;
      }
      const startLine = this.peek().line;
      const colName = this.parseIdentifier();
      let dataType: string | undefined;
      let expr: Expr | undefined;

      if (this.peek().type === 'keyword' && DATA_TYPES.has(this.peek().value)) {
        dataType = this.parseDataType();
      }
      // 内联约束/默认值/生成列
      while (!this.isPunct(',') && !this.isPunct(')') && !this.atEnd()) {
        if (this.isKw('GENERATED')) {
          this.next();
          this.matchKw('ALWAYS');
          this.matchKw('AS');
          if (this.matchPunct('(')) {
            expr = this.parseExpr();
            this.expectPunct(')');
          }
          this.matchKw('VIRTUAL');
        } else if (this.isKw('DEFAULT')) {
          this.next();
          if (this.matchPunct('(')) {
            expr = this.parseExpr();
            this.expectPunct(')');
          } else {
            expr = this.parseExpr();
          }
        } else if (this.isKw('AS') && this.peek(1)?.type === 'punct' && this.peek(1).value === '(') {
          this.next();
          this.expectPunct('(');
          expr = this.parseExpr();
          this.expectPunct(')');
          this.matchKw('VIRTUAL');
        } else {
          this.next();
        }
      }
      columns.push({ name: colName, dataType, expr, startLine });
    } while (this.matchPunct(','));
    return columns;
  }

  private parseDataType(): string {
    const base = this.next().value;
    let text = base;
    if (this.matchPunct('(')) {
      let inner = '';
      let depth = 1;
      while (depth > 0 && !this.atEnd()) {
        const t = this.next();
        if (t.value === '(') depth++;
        if (t.value === ')') depth--;
        if (depth > 0) inner += t.text;
      }
      text += `(${inner})`;
    }
    // Hive 复合类型 ARRAY<...>
    if (this.matchOp('<')) {
      let depth = 1;
      let inner = '';
      while (depth > 0 && !this.atEnd()) {
        const t = this.next();
        if (t.value === '<') depth++;
        if (t.value === '>') depth--;
        if (depth > 0) inner += t.text;
      }
      text += `<${inner}>`;
    }
    return text;
  }

  private skipTableTail(): void {
    const stopAt = new Set(['SELECT', 'INSERT', 'CREATE', 'MERGE', 'WITH']);
    while (!this.atEnd()) {
      const t = this.peek();
      if (t.type === 'keyword' && stopAt.has(t.value)) return;
      this.next();
    }
  }

  private skipParenGroup(): void {
    if (!this.isPunct('(')) {
      // 跳过裸关键字直到逗号
      while (!this.isPunct(',') && !this.isPunct(')') && !this.atEnd()) this.next();
      return;
    }
    let depth = 0;
    do {
      if (this.isPunct('(')) depth++;
      if (this.isPunct(')')) depth--;
      this.next();
    } while (depth > 0 && !this.atEnd());
  }

  // ---------------------------------------------------------
  // INSERT
  // ---------------------------------------------------------
  private parseInsert(startLine: number): InsertStmt {
    // Hive/标准 SQL 允许 WITH ... INSERT INTO ... SELECT
    const leadingCtes = this.isKw('WITH') ? this.parseWithClause() : undefined;
    this.expectKw('INSERT');
    let overwrite = false;
    if (this.matchKw('OVERWRITE')) overwrite = true;
    else this.matchKw('INTO');
    this.matchKw('TABLE');
    const table = this.parseTableName();

    let columns: string[] | undefined;
    let partitionSpec: string[] | undefined;
    if (this.matchKw('PARTITION')) {
      this.expectPunct('(');
      partitionSpec = [];
      do {
        partitionSpec.push(this.parseIdentifier());
        // 分区赋值 p='x' 吞掉值
        if (this.matchOp('=')) this.parseExpr();
      } while (this.matchPunct(','));
      this.expectPunct(')');
    }
    if (this.matchPunct('(')) {
      columns = [this.parseIdentifier()];
      while (this.matchPunct(',')) columns.push(this.parseIdentifier());
      this.expectPunct(')');
    }

    if (this.isKw('SELECT') || this.isKw('WITH')) {
      const query = this.parseSelect(startLine);
      if (leadingCtes?.size) query.cteDefs = new Map([...leadingCtes, ...(query.cteDefs ?? [])]);
      return { kind: 'insert', table, columns, query, overwrite, partitionSpec, startLine };
    }
    if (this.matchKw('VALUES')) {
      const values: Expr[][] = [];
      do {
        this.expectPunct('(');
        const row: Expr[] = [this.parseExpr()];
        while (this.matchPunct(',')) row.push(this.parseExpr());
        this.expectPunct(')');
        values.push(row);
      } while (this.matchPunct(','));
      return { kind: 'insert', table, columns, values, overwrite, partitionSpec, startLine };
    }
    throw new Error(`INSERT 后应为 SELECT 或 VALUES (行 ${this.peek().line})`);
  }

  // ---------------------------------------------------------
  // MERGE
  // ---------------------------------------------------------
  private parseMerge(startLine: number): MergeStmt {
    this.expectKw('MERGE');
    this.expectKw('INTO');
    const target = this.parseTableName();
    const targetAlias = this.parseAlias();
    this.expectKw('USING');
    const source = this.parseTableRef();
    this.expectKw('ON');
    if (this.isPunct('(')) {
      this.expectPunct('(');
      this.parseExpr();
      this.expectPunct(')');
    } else {
      this.parseExpr(); // 关联条件,血缘阶段不需要单独保留
    }
    const assignments: MergeStmt['assignments'] = [];
    while (this.matchKw('WHEN')) {
      this.matchKw('NOT');
      this.expectKw('MATCHED');
      // THEN INSERT (...) VALUES (...) / THEN UPDATE SET ...
      if (this.matchKw('THEN')) {
        if (this.isKw('INSERT')) {
          this.next();
          let cols: string[] | undefined;
          if (this.matchPunct('(')) {
            cols = [this.parseIdentifier()];
            while (this.matchPunct(',')) cols.push(this.parseIdentifier());
            this.expectPunct(')');
          }
          if (this.matchKw('VALUES')) {
            this.expectPunct('(');
            const exprs: Expr[] = [this.parseExpr()];
            while (this.matchPunct(',')) exprs.push(this.parseExpr());
            this.expectPunct(')');
            (cols ?? exprs.map((_, idx) => `COL${idx + 1}`)).forEach((c, idx) => {
              if (exprs[idx]) assignments.push({ column: c, expr: exprs[idx] });
            });
          }
        } else if (this.isKw('UPDATE')) {
          this.next();
          this.expectKw('SET');
          do {
            // 目标列可能带表别名限定,如 t.cust_name
            const qualified = this.parseTableName();
            const column = qualified.parts[qualified.parts.length - 1];
            this.matchOp('=');
            const expr = this.parseExpr();
            assignments.push({ column, expr });
          } while (this.matchPunct(','));
        } else if (this.isKw('DELETE')) {
          this.next();
        }
      }
    }
    return { kind: 'merge', target, targetAlias, source, assignments, startLine };
  }

  // ---------------------------------------------------------
  // SELECT / CTE / 集合运算
  // ---------------------------------------------------------
  private parseWithClause(): Map<string, SelectStmt> {
    const cteDefs = new Map<string, SelectStmt>();
    if (!this.matchKw('WITH')) return cteDefs;
    this.matchKw('RECURSIVE');
    do {
      const cteName = this.parseIdentifier();
      let columnAliases: string[] | undefined;
      if (this.matchPunct('(')) {
        columnAliases = [this.parseIdentifier()];
        while (this.matchPunct(',')) columnAliases.push(this.parseIdentifier());
        this.expectPunct(')');
      }
      this.expectKw('AS');
      this.expectPunct('(');
      const cteQuery = this.parseSelect(this.peek().line);
      this.expectPunct(')');
      if (columnAliases) this.renameCteOutputs(cteQuery, columnAliases);
      cteDefs.set(cteName.toUpperCase(), cteQuery);
    } while (this.matchPunct(','));
    return cteDefs;
  }

  private parseSelect(startLine: number): SelectStmt {
    const cteDefs = this.parseWithClause();

    const select = this.parseSingleSelect(startLine);
    if (cteDefs.size) select.cteDefs = cteDefs;

    // 集合运算
    while (this.peek().type === 'keyword' && SET_OPS.has(this.peek().value)) {
      const op = this.next().value as SetOp['op'];
      const all = op === 'UNION' && this.matchKw('ALL');
      const right = this.parseSingleSelect(this.peek().line);
      select.setOps ??= [];
      select.setOps.push({ op: all ? 'UNION ALL' : op, all, query: right });
    }
    return select;
  }

  private renameCteOutputs(query: SelectStmt, aliases: string[]): void {
    query.projections.forEach((p, idx) => {
      if (aliases[idx]) {
        p.alias = aliases[idx];
        p.outputName = aliases[idx];
      }
    });
  }

  private parseSingleSelect(startLine: number): SelectStmt {
    this.expectKw('SELECT');
    const distinct = this.matchKw('DISTINCT');
    this.matchKw('ALL');

    const projections: Projection[] = [];
    do {
      const projStart = this.peek().line;
      // star / t.*
      if (this.isOp('*')) {
        this.next();
        projections.push({
          expr: { kind: 'star', text: '*' },
          outputName: '*',
          star: true,
          startLine: projStart,
        });
        continue;
      }
      const expr = this.parseExpr();
      if (expr.kind === 'star') {
        projections.push({ expr, outputName: '*', star: true, starQualifier: expr.qualifier, startLine: projStart });
        continue;
      }
      const alias = this.parseAlias();
      let outputName: string;
      if (alias) outputName = alias;
      else if (expr.kind === 'columnRef') outputName = expr.name;
      else outputName = `EXPR${projections.length + 1}`;
      projections.push({ expr, alias, outputName, star: false, startLine: projStart });
    } while (this.matchPunct(','));

    const from: TableRef[] = [];
    if (this.matchKw('FROM')) {
      from.push(this.parseFromChain());
    }

    let where: Expr | undefined;
    if (this.matchKw('WHERE')) where = this.parseExpr();

    let groupBy: Expr[] | undefined;
    if (this.matchKw('GROUP')) {
      this.expectKw('BY');
      groupBy = [this.parseExpr()];
      while (this.matchPunct(',')) groupBy.push(this.parseExpr());
    }

    let having: Expr | undefined;
    if (this.matchKw('HAVING')) having = this.parseExpr();

    let orderBy: SelectStmt['orderBy'];
    if (this.matchKw('ORDER')) {
      this.expectKw('BY');
      orderBy = [];
      do {
        const expr = this.parseExpr();
        let desc = false;
        if (this.matchKw('DESC')) desc = true;
        else this.matchKw('ASC');
        orderBy.push({ expr, desc });
      } while (this.matchPunct(','));
    }

    // Hive: CLUSTER BY / DISTRIBUTE BY / SORT BY
    if (this.matchKw('CLUSTER') || this.matchKw('DISTRIBUTE') || this.matchKw('SORT')) {
      this.matchKw('BY');
      while (!this.atEnd() && !this.isClauseBoundary()) this.next();
    }
    if (this.matchKw('QUALIFY')) this.parseExpr();

    let limit: number | undefined;
    if (this.matchKw('LIMIT')) {
      const t = this.next();
      limit = Number(t.value);
    }

    return { kind: 'select', distinct, projections, from, where, groupBy, having, orderBy, limit, startLine };
  }

  private isClauseBoundary(): boolean {
    return this.isKw('WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS');
  }

  private isOp(op: string): boolean {
    return this.peek().type === 'op' && this.peek().value === op;
  }

  // ---------------------------------------------------------
  // FROM / JOIN / LATERAL VIEW
  // ---------------------------------------------------------
  private parseFromChain(): TableRef {
    let left = this.parseTableRef();

    // 逗号隐式交叉连接
    while (this.isPunct(',')) {
      this.next();
      const right = this.parseTableRef();
      left = {
        kind: 'join',
        joinType: 'CROSS',
        left,
        right,
        startLine: right.startLine,
      };
    }

    for (;;) {
      if (this.matchKw('LATERAL')) {
        this.matchKw('VIEW');
        const outer = this.matchKw('OUTER');
        const func = this.parseFuncName();
        let args: Expr[] = [];
        if (this.matchPunct('(')) {
          if (!this.isPunct(')')) {
            args = [this.parseExpr()];
            while (this.matchPunct(',')) args.push(this.parseExpr());
          }
          this.expectPunct(')');
        }
        const tableAlias = this.parseAlias();
        let columnAliases: string[] = [];
        if (this.matchKw('AS')) {
          columnAliases = [this.parseIdentifier()];
          while (this.matchPunct(',')) columnAliases.push(this.parseIdentifier());
        } else if (this.peek().type === 'identifier') {
          columnAliases = [this.next().value];
          while (this.matchPunct(',')) columnAliases.push(this.parseIdentifier());
        }
        const lateral: LateralViewRef = {
          kind: 'lateral',
          base: left,
          outer,
          func,
          tableAlias,
          columnAliases,
          startLine: left.startLine,
        };
        // 把 explode 参数挂到 func 名上,血缘分析器需要
        (lateral as LateralViewRef & { args?: Expr[] }).args = args;
        left = lateral;
        continue;
      }

      let joinType: JoinRef['joinType'] | undefined;
      let natural = false;
      if (this.matchKw('NATURAL')) natural = true;
      if (this.isKw(...JOIN_TYPES)) {
        const t = this.next().value;
        if (t === 'INNER') joinType = 'INNER';
        else if (t === 'LEFT') joinType = 'LEFT';
        else if (t === 'RIGHT') joinType = 'RIGHT';
        else if (t === 'FULL') joinType = 'FULL';
        else if (t === 'CROSS') joinType = 'CROSS';
        else if (t === 'SEMI') joinType = 'SEMI';
        else if (t === 'ANTI') joinType = 'ANTI';
        this.matchKw('OUTER');
      }
      if (!this.matchKw('JOIN')) {
        if (natural) {
          joinType = 'INNER';
        } else {
          break;
        }
      }
      if (!joinType) joinType = 'INNER';
      const right = this.parseTableRef();
      let on: Expr | undefined;
      if (this.matchKw('ON')) on = this.parseExpr();
      if (this.matchKw('USING')) {
        this.expectPunct('(');
        const cols: Expr[] = [this.columnRef(this.parseIdentifier())];
        while (this.matchPunct(',')) cols.push(this.columnRef(this.parseIdentifier()));
        this.expectPunct(')');
        on = { kind: 'tuple', items: cols, text: '' };
      }
      left = { kind: 'join', joinType, left, right, on, startLine: right.startLine };
    }
    return left;
  }

  private parseTableRef(): TableRef {
    const startLine = this.peek().line;
    if (this.matchPunct('(')) {
      // 括号内可能是 SELECT 子查询,也可能是嵌套 join
      if (this.isKw('SELECT') || this.isKw('WITH')) {
        const query = this.parseSelect(startLine);
        this.expectPunct(')');
        const alias = this.parseAlias();
        let columnAliases: string[] | undefined;
        return { kind: 'subquery', query, alias, columnAliases, startLine };
      }
      const inner = this.parseFromChain();
      this.expectPunct(')');
      const alias = this.parseAlias();
      return alias
        ? { kind: 'subquery', query: this.wrapRefAsSelect(inner, alias, startLine), alias, startLine }
        : inner;
    }

    const name = this.parseTableName();
    const alias = this.parseAlias();
    return { kind: 'relation', name, alias, startLine };
  }

  /** 括号 join 退化处理:包成只做透传的 SELECT */
  private wrapRefAsSelect(ref: TableRef, _alias: string, line: number): SelectStmt {
    return {
      kind: 'select',
      distinct: false,
      projections: [
        { expr: { kind: 'star', text: '*' }, outputName: '*', star: true, startLine: line },
      ],
      from: [ref],
      startLine: line,
    };
  }

  // ---------------------------------------------------------
  // 表达式(优先级爬升)
  // ---------------------------------------------------------
  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.matchKw('OR')) {
      const right = this.parseAnd();
      left = { kind: 'binary', op: 'OR', left, right, text: '' };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.matchKw('AND')) {
      const right = this.parseNot();
      left = { kind: 'binary', op: 'AND', left, right, text: '' };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.matchKw('NOT')) {
      return { kind: 'unary', op: 'NOT', expr: this.parseNot(), text: '' };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    for (;;) {
      if (this.isKw('IS')) {
        this.next();
        const neg = this.matchKw('NOT');
        this.expectKw('NULL');
        left = { kind: 'binary', op: neg ? 'IS NOT' : 'IS', left, right: { kind: 'literal', value: 'NULL', literalType: 'null' }, text: '' };
        continue;
      }
      if (this.isKw('LIKE') || (this.isKw('NOT') && this.peek(1)?.value === 'LIKE')) {
        const neg = this.matchKw('NOT');
        this.expectKw('LIKE');
        const right = this.parseAdditive();
        left = { kind: 'binary', op: neg ? 'NOT LIKE' : 'LIKE', left, right, text: '' };
        continue;
      }
      if (this.isKw('BETWEEN') || (this.isKw('NOT') && this.peek(1)?.value === 'BETWEEN')) {
        const neg = this.matchKw('NOT');
        this.expectKw('BETWEEN');
        const low = this.parseAdditive();
        this.expectKw('AND');
        const high = this.parseAdditive();
        const between: BetweenExpr = { kind: 'between', expr: left, negated: neg, low, high, text: '' };
        left = between;
        continue;
      }
      if (this.isKw('IN') || (this.isKw('NOT') && this.peek(1)?.value === 'IN')) {
        const neg = this.matchKw('NOT');
        this.expectKw('IN');
        left = this.parseInTail(left, neg);
        continue;
      }
      const t = this.peek();
      if (t.type === 'op' && ['=', '<>', '!=', '>', '>=', '<', '<='].includes(t.value)) {
        const op = this.next().value;
        const right = this.parseAdditive();
        left = { kind: 'binary', op, left, right, text: '' };
        continue;
      }
      break;
    }
    return left;
  }

  private parseInTail(left: Expr, neg: boolean): InExpr {
    this.expectPunct('(');
    if (this.isKw('SELECT') || this.isKw('WITH')) {
      const query = this.parseSelect(this.peek().line);
      this.expectPunct(')');
      return { kind: 'in', expr: left, negated: neg, list: [], subquery: query, text: '' };
    }
    const list: Expr[] = [this.parseExpr()];
    while (this.matchPunct(',')) list.push(this.parseExpr());
    this.expectPunct(')');
    return { kind: 'in', expr: left, negated: neg, list, text: '' };
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-') || this.isOp('||')) {
      const op = this.next().value;
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op, left, right, text: '' };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right, text: '' };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.next().value;
      return { kind: 'unary', op, expr: this.parseUnary(), text: '' };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.type === 'number') {
      this.next();
      return { kind: 'literal', value: t.value, literalType: 'number' };
    }
    if (t.type === 'string') {
      this.next();
      return { kind: 'literal', value: t.value, literalType: 'string' };
    }
    if (t.type === 'variable') {
      this.next();
      const param: ParamExpr = { kind: 'param', name: t.value, text: t.text };
      return param;
    }
    if (t.type === 'punct' && t.value === '(') {
      this.next();
      if (this.isKw('SELECT') || this.isKw('WITH')) {
        const query = this.parseSelect(t.line);
        this.expectPunct(')');
        const sq: SubqueryExpr = { kind: 'subqueryExpr', query, text: '' };
        return sq;
      }
      const first = this.parseExpr();
      if (this.isPunct(',')) {
        const items = [first];
        while (this.matchPunct(',')) items.push(this.parseExpr());
        this.expectPunct(')');
        const tuple: TupleExpr = { kind: 'tuple', items, text: '' };
        return tuple;
      }
      this.expectPunct(')');
      return first;
    }
    if (t.type === 'keyword') {
      if (t.value === 'NULL') {
        this.next();
        return { kind: 'literal', value: 'NULL', literalType: 'null' };
      }
      if (t.value === 'TRUE' || t.value === 'FALSE') {
        this.next();
        return { kind: 'literal', value: t.value, literalType: 'boolean' };
      }
      if (t.value === 'CASE') return this.parseCase();
      if (t.value === 'CAST') return this.parseCast();
      if (t.value === 'EXISTS') {
        this.next();
        this.expectPunct('(');
        const query = this.parseSelect(t.line);
        this.expectPunct(')');
        return { kind: 'subqueryExpr', query, text: 'EXISTS' };
      }
      if (t.value === 'INTERVAL') {
        this.next();
        const val = this.parsePrimary();
        const unit = this.next().value;
        return { kind: 'func', name: 'INTERVAL', args: [val], distinct: false, starArg: false, text: unit };
      }
    }
    if (t.type === 'identifier' || t.type === 'keyword') {
      return this.parseNamedPrimary();
    }
    throw new Error(`无法解析的表达式片段 "${t.text || t.type}" (行 ${t.line})`);
  }

  private parseNamedPrimary(): Expr {
    // 函数调用 or 列引用
    const first = this.takeNamePart();
    let nameParts = [first];
    while (this.isPunct('.')) {
      this.next();
      nameParts.push(this.takeNamePart());
    }

    // 函数:最后一段名字 + 紧跟 (
    if (this.isPunct('(')) {
      const funcName = nameParts.join('.');
      const call = this.parseFuncCall(funcName);
      // 窗口函数
      if (this.isKw('OVER')) {
        this.next();
        const over = this.parseWindowSpec();
        const wf: WindowFuncExpr = { kind: 'windowFunc', func: call, over, text: '' };
        // 窗口后可能还有别名,由上层处理
        return wf;
      }
      return call;
    }

    // star: t.* —— 仅当 "*" 紧跟在点号之后(即 t.*),裸列乘法 a * b 不在此处理
    if (this.isOp('*') && this.tokens[this.pos - 1]?.type === 'punct' && this.tokens[this.pos - 1]?.value === '.') {
      this.next();
      const star: StarExpr = {
        kind: 'star',
        qualifier: nameParts.join('.'),
        text: `${nameParts.join('.')}.*`,
      };
      return star;
    }

    // 普通列引用
    if (nameParts.length === 1) return this.columnRef(nameParts[0]);
    const colName = nameParts[nameParts.length - 1];
    const qualifier = nameParts.slice(0, -1).join('.');
    const ref: ColumnRefExpr = { kind: 'columnRef', qualifier, name: colName, text: nameParts.join('.') };
    return ref;
  }

  private takeNamePart(): string {
    const t = this.peek();
    if (t.type === 'identifier' || t.type === 'keyword') {
      this.next();
      return t.value;
    }
    throw new Error(`期望名称片段 (行 ${t.line})`);
  }

  private columnRef(name: string, qualifier?: string): ColumnRefExpr {
    return { kind: 'columnRef', name, qualifier, text: qualifier ? `${qualifier}.${name}` : name };
  }

  private parseFuncName(): string {
    const parts = [this.takeNamePart()];
    while (this.isPunct('.')) {
      this.next();
      parts.push(this.takeNamePart());
    }
    return parts.join('.');
  }

  private parseFuncCall(name: string): FuncCallExpr {
    this.expectPunct('(');
    const args: Expr[] = [];
    let distinct = false;
    let starArg = false;
    if (this.isOp('*')) {
      this.next();
      starArg = true;
    } else if (!this.isPunct(')')) {
      distinct = this.matchKw('DISTINCT');
      this.matchKw('ALL');
      args.push(this.parseExpr());
      while (this.matchPunct(',')) args.push(this.parseExpr());
    }
    this.expectPunct(')');
    return { kind: 'func', name, args, distinct, starArg, text: name };
  }

  private parseWindowSpec(): WindowFuncExpr['over'] {
    this.expectPunct('(');
    const over: WindowFuncExpr['over'] = {};
    if (this.matchKw('PARTITION')) {
      this.expectKw('BY');
      over.partitionBy = [this.parseExpr()];
      while (this.matchPunct(',')) over.partitionBy.push(this.parseExpr());
    }
    if (this.matchKw('ORDER')) {
      this.expectKw('BY');
      over.orderBy = [];
      do {
        const expr = this.parseExpr();
        let desc = false;
        if (this.matchKw('DESC')) desc = true;
        else this.matchKw('ASC');
        over.orderBy.push({ expr, desc });
      } while (this.matchPunct(','));
    }
    if (this.isKw('ROWS') || this.isKw('RANGE')) {
      const frameKw = this.next().value;
      let frame = frameKw;
      let depth = 1;
      // frame 子句到右括号
      while (depth > 0 && !this.atEnd() && !this.isPunct(')')) {
        const tk = this.next();
        frame += ` ${tk.text}`;
      }
      over.frame = frame.trim();
    }
    this.expectPunct(')');
    return over;
  }

  private parseCase(): CaseExpr {
    this.expectKw('CASE');
    let operand: Expr | undefined;
    if (!this.isKw('WHEN')) operand = this.parseExpr();
    const whens: CaseExpr['whens'] = [];
    while (this.matchKw('WHEN')) {
      const cond = this.parseExpr();
      this.expectKw('THEN');
      const result = this.parseExpr();
      whens.push({ cond, result });
    }
    let elseResult: Expr | undefined;
    if (this.matchKw('ELSE')) elseResult = this.parseExpr();
    this.expectKw('END');
    return { kind: 'case', operand, whens, elseResult, text: '' };
  }

  private parseCast(): CastExpr {
    this.expectKw('CAST');
    this.expectPunct('(');
    const expr = this.parseExpr();
    this.expectKw('AS');
    const dataType = this.parseDataType();
    this.expectPunct(')');
    return { kind: 'cast', expr, dataType, text: '' };
  }
}
