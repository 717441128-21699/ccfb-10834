import { Token, TokenType } from './types';

// ------------------------------------------------------------
// 关键字集合(Oracle + Hive 并集,parser 按上下文区分语义)
// ------------------------------------------------------------
const KEYWORDS = new Set<string>([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC',
  'LIMIT', 'DISTINCT', 'ALL', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
  'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'UNION', 'INTERSECT', 'EXCEPT', 'MINUS',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'USING',
  'WITH', 'RECURSIVE',
  'CREATE', 'TABLE', 'VIEW', 'OR', 'REPLACE', 'FORCE', 'IF', 'EXISTS',
  'INSERT', 'INTO', 'OVERWRITE', 'VALUES', 'MERGE', 'MATCHED', 'UPDATE', 'SET',
  'DELETE', 'OVER', 'PARTITION', 'WINDOW',
  'CAST', 'DECIMAL', 'NUMBER', 'VARCHAR', 'VARCHAR2', 'CHAR', 'DATE',
  'TIMESTAMP', 'INT', 'INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT', 'STRING',
  'BOOLEAN', 'BINARY', 'ARRAY', 'MAP', 'STRUCT',
  'LATERAL', 'EXPLODE', 'POSEXPLODE', 'INLINE', 'STACK',
  'EXTERNAL', 'STORED', 'AS', 'COMMENT', 'CONSTRAINT', 'PRIMARY', 'KEY',
  'GENERATED', 'ALWAYS', 'VIRTUAL', 'DEFAULT', 'CHECK', 'REFERENCES',
  'TRUE', 'FALSE', 'CLUSTER', 'DISTRIBUTE', 'SORT', 'TBLPROPERTIES',
  'ROW', 'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT',
  'NATURAL', 'SEMI', 'ANTI', 'USING', 'QUALIFY',
  'TRUNCATE', 'DROP', 'ALTER', 'GRANT', 'BEGIN', 'DECLARE', 'PROCEDURE',
  'FUNCTION', 'RETURN', 'EXECUTE', 'IMMEDIATE', 'LOOP', 'END', 'EXCEPTION',
]);

const ID_START = /[A-Za-z_一-龥]/;
const ID_PART = /[A-Za-z0-9_$#一-龥]/;

export interface TokenizeResult {
  tokens: Token[];
  errors: { message: string; line: number }[];
}

export function tokenize(sql: string): TokenizeResult {
  const tokens: Token[] = [];
  const errors: { message: string; line: number }[] = [];
  let i = 0;
  let line = 1;
  const n = sql.length;

  const push = (type: TokenType, text: string, value: string, start: number, kw?: string) => {
    tokens.push({ type, text, value, start, end: i, line, kw });
  };

  while (i < n) {
    const c = sql[i];

    // 空白
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      if (c === '\n') line++;
      i++;
      continue;
    }

    // 行注释
    if (c === '-' && sql[i + 1] === '-') {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      push('comment', sql.slice(start, i), '', start);
      continue;
    }

    // 块注释(含 Oracle hint /*+ ... */)
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') line++;
        i++;
      }
      i += 2;
      push('comment', sql.slice(start, i), '', start);
      continue;
    }

    // 单引号字符串
    if (c === "'") {
      const start = i;
      i++;
      let val = '';
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            val += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (sql[i] === '\n') line++;
        val += sql[i];
        i++;
      }
      push('string', sql.slice(start, i), val, start);
      continue;
    }

    // Oracle q-quote 以 q/Q 开头:q'[...]',必须在标识符分支之前拦截
    if ((c === 'q' || c === 'Q') && sql[i + 1] === "'") {
      const start = i;
      const open = sql[i + 2];
      const closeMap: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };
      const close = closeMap[open] ?? open;
      i += 3;
      while (i < n && sql[i] !== close) {
        if (sql[i] === '\n') line++;
        i++;
      }
      i = Math.min(n, i + 2); // 跳过 close 与收尾引号
      push('string', sql.slice(start, i), sql.slice(start + 3, i - 2), start);
      continue;
    }

    // 双引号标识符
    if (c === '"') {
      const start = i;
      i++;
      let val = '';
      while (i < n && sql[i] !== '"') {
        val += sql[i];
        i++;
      }
      i++;
      push('identifier', sql.slice(start, i), val.toUpperCase(), start);
      continue;
    }

    // Hive 反引号标识符
    if (c === '`') {
      const start = i;
      i++;
      let val = '';
      while (i < n && sql[i] !== '`') {
        val += sql[i];
        i++;
      }
      i++;
      push('identifier', sql.slice(start, i), val.toUpperCase(), start);
      continue;
    }

    // Hive 变量 ${...}
    if (c === '$' && sql[i + 1] === '{') {
      const start = i;
      let depth = 0;
      while (i < n) {
        if (sql[i] === '{') depth++;
        if (sql[i] === '}') depth--;
        i++;
        if (depth === 0) break;
      }
      const text = sql.slice(start, i);
      push('variable', text, text.slice(2, -1), start);
      continue;
    }

    // 绑定变量 :name / &name
    if (c === ':' || c === '&') {
      const start = i;
      i++;
      while (i < n && ID_PART.test(sql[i])) i++;
      const text = sql.slice(start, i);
      if (text.length > 1) {
        push('variable', text, text.slice(1), start);
        continue;
      }
      // 单独的冒号,按运算符处理
      push('op', ':', ':', start);
      continue;
    }

    // 数字
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9.]/.test(sql[i])) i++;
      if (sql[i] === 'e' || sql[i] === 'E') {
        i++;
        if (sql[i] === '+' || sql[i] === '-') i++;
        while (i < n && /[0-9]/.test(sql[i])) i++;
      }
      const text = sql.slice(start, i);
      push('number', text, text, start);
      continue;
    }

    // 标识符 / 关键字
    if (ID_START.test(c)) {
      const start = i;
      i++;
      while (i < n && ID_PART.test(sql[i])) i++;
      const text = sql.slice(start, i);
      const upper = text.toUpperCase();
      if (KEYWORDS.has(upper)) {
        push('keyword', text, upper, start, upper);
      } else {
        push('identifier', text, upper, start);
      }
      continue;
    }

    // 多字符运算符
    const start = i;
    const two = sql.slice(i, i + 2);
    if (two === '||' || two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '=>' || two === '::') {
      push('op', two, two, start);
      i += 2;
      continue;
    }
    if ('+-*/=%<>!|~^'.includes(c)) {
      push('op', c, c, start);
      i++;
      continue;
    }
    if ('(),.;[]{}?'.includes(c)) {
      push('punct', c, c, start);
      i++;
      continue;
    }

    // 无法识别的字符:跳过并记录,不致命
    errors.push({ message: `无法识别的字符 "${c}"`, line });
    i++;
  }

  push('eof', '', '', n);
  return { tokens: tokens.filter((t) => t.type !== 'comment'), errors };
}
