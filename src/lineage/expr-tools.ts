import { Expr } from '../parser/types';

export interface ColumnRef {
  qualifier?: string;
  name: string;
  text: string;
}

/** 递归收集表达式中的全部列引用(含子查询、窗口、CASE) */
export function collectColumnRefs(expr: Expr | undefined, out: ColumnRef[] = []): ColumnRef[] {
  if (!expr) return out;
  switch (expr.kind) {
    case 'columnRef':
      out.push({ qualifier: expr.qualifier, name: expr.name, text: expr.text });
      return out;
    case 'literal':
    case 'param':
    case 'star':
      return out;
    case 'binary':
      collectColumnRefs(expr.left, out);
      collectColumnRefs(expr.right, out);
      return out;
    case 'unary':
      return collectColumnRefs(expr.expr, out);
    case 'func':
      expr.args.forEach((a) => collectColumnRefs(a, out));
      return out;
    case 'case':
      collectColumnRefs(expr.operand, out);
      expr.whens.forEach((w) => {
        collectColumnRefs(w.cond, out);
        collectColumnRefs(w.result, out);
      });
      collectColumnRefs(expr.elseResult, out);
      return out;
    case 'cast':
      return collectColumnRefs(expr.expr, out);
    case 'windowFunc':
      collectColumnRefs(
        { kind: 'func', name: expr.func.name, args: expr.func.args, distinct: false, starArg: false, text: '' },
        out,
      );
      expr.over.partitionBy?.forEach((e) => collectColumnRefs(e, out));
      expr.over.orderBy?.forEach((o) => collectColumnRefs(o.expr, out));
      return out;
    case 'between':
      collectColumnRefs(expr.expr, out);
      collectColumnRefs(expr.low, out);
      collectColumnRefs(expr.high, out);
      return out;
    case 'in':
      collectColumnRefs(expr.expr, out);
      // IN (SELECT ...) 子查询有独立作用域,不在此穿透,由分析器单独处理
      expr.list.forEach((e) => collectColumnRefs(e, out));
      return out;
    case 'tuple':
      expr.items.forEach((i) => collectColumnRefs(i, out));
      return out;
    case 'subqueryExpr':
      // 标量子查询有独立 FROM 作用域,内部列不当作外层表达式的直接引用
      return out;
  }
  return out;
}

/** 判断表达式是否为"原样搬运":单个裸列、无任何运算 */
export function isPassthrough(expr: Expr): boolean {
  return expr.kind === 'columnRef';
}

export function isAggregateExpr(expr: Expr): boolean {
  if (expr.kind === 'windowFunc') return isAggregateName(expr.func.name);
  if (expr.kind === 'func') return isAggregateName(expr.name);
  return false;
}

const AGG_NAMES = new Set([
  'SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'COLLECT_LIST', 'COLLECT_SET',
  'LISTAGG', 'GROUP_CONCAT', 'STDDEV', 'VARIANCE', 'VAR_POP', 'VAR_SAMP',
  'PERCENTILE_CONT', 'PERCENTILE_DISC', 'FIRST', 'LAST',
]);

export function isAggregateName(name: string): boolean {
  return AGG_NAMES.has(name.toUpperCase());
}

/** 规范化序列化表达式,用于两版算法比对(忽略空白与别名差异) */
export function serializeExpr(expr: Expr | undefined): string {
  if (!expr) return '';
  switch (expr.kind) {
    case 'columnRef':
      return expr.qualifier ? `${expr.qualifier}.${expr.name}` : expr.name;
    case 'literal':
      return `'${expr.value}'`;
    case 'param':
      return '${PARAM}';
    case 'star':
      return expr.qualifier ? `${expr.qualifier}.*` : '*';
    case 'binary':
      return `(${serializeExpr(expr.left)} ${expr.op} ${serializeExpr(expr.right)})`;
    case 'unary':
      return `(${expr.op} ${serializeExpr(expr.expr)})`;
    case 'func':
      return `${expr.name}(${expr.distinct ? 'DISTINCT ' : ''}${expr.starArg ? '*' : expr.args.map(serializeExpr).join(', ')})`;
    case 'case': {
      const base = expr.operand ? `CASE ${serializeExpr(expr.operand)} ` : 'CASE ';
      const whens = expr.whens
        .map((w) => `WHEN ${serializeExpr(w.cond)} THEN ${serializeExpr(w.result)}`)
        .join(' ');
      const elsePart = expr.elseResult ? ` ELSE ${serializeExpr(expr.elseResult)}` : '';
      return `${base}${whens}${elsePart} END`;
    }
    case 'cast':
      return `CAST(${serializeExpr(expr.expr)} AS ${expr.dataType})`;
    case 'windowFunc': {
      const fn = serializeExpr({
        kind: 'func',
        name: expr.func.name,
        args: expr.func.args,
        distinct: expr.func.distinct,
        starArg: expr.func.starArg,
        text: '',
      });
      const parts: string[] = [];
      if (expr.over.partitionBy?.length) parts.push(`PARTITION BY ${expr.over.partitionBy.map(serializeExpr).join(', ')}`);
      if (expr.over.orderBy?.length) {
        parts.push(
          `ORDER BY ${expr.over.orderBy.map((o) => `${serializeExpr(o.expr)}${o.desc ? ' DESC' : ''}`).join(', ')}`,
        );
      }
      if (expr.over.frame) parts.push(expr.over.frame);
      return `${fn} OVER (${parts.join(' ')})`;
    }
    case 'between':
      return `${serializeExpr(expr.expr)} ${expr.negated ? 'NOT ' : ''}BETWEEN ${serializeExpr(expr.low)} AND ${serializeExpr(expr.high)}`;
    case 'in':
      if (expr.subquery) return `${serializeExpr(expr.expr)} IN (SUBQUERY)`;
      return `${serializeExpr(expr.expr)} IN (${expr.list.map(serializeExpr).join(', ')})`;
    case 'tuple':
      return `(${expr.items.map(serializeExpr).join(', ')})`;
    case 'subqueryExpr':
      return '(SUBQUERY)';
  }
}

/** 提取表达式里最外层的加工函数标签(用于边展示) */
export function topFuncLabel(expr: Expr): string | undefined {
  if (expr.kind === 'windowFunc') return expr.func.name;
  if (expr.kind === 'func') return expr.name;
  if (expr.kind === 'case') return 'CASE';
  if (expr.kind === 'cast') return 'CAST';
  if (expr.kind === 'binary') {
    if (expr.op === '||' || expr.op === 'CONCAT') return 'CONCAT';
    return expr.op;
  }
  if (expr.kind === 'unary') return expr.op;
  return undefined;
}
