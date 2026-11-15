import { tokenize } from './tokenizer';
import { DynamicSqlSnippet } from './types';

export interface RawStatement {
  text: string;
  startLine: number;
  isPlsql: boolean;
  dynamicSnippets: DynamicSqlSnippet[];
}

const BLOCK_START =
  /^\s*(CREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|PACKAGE)|DECLARE|BEGIN)\b/i;

/**
 * 把整份脚本切成独立语句。
 * - PL/SQL 块优先按 SQL*Plus 的独立 "/" 行切,退化时按 BEGIN/END 嵌套切
 * - 普通 SQL 按顶层分号切(忽略字符串/括号内的分号)
 * - 同时抽取块内 EXECUTE IMMEDIATE 动态 SQL
 */
export function splitStatements(raw: string, file?: string): RawStatement[] {
  const lines = raw.split(/\r?\n/);
  const result: RawStatement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('--')) {
      i++;
      continue;
    }

    const startLine = i + 1;
    if (BLOCK_START.test(line)) {
      let j = i + 1;
      let slashLine = -1;
      while (j < lines.length) {
        if (/^\s*\/\s*$/.test(lines[j])) {
          slashLine = j;
          break;
        }
        j++;
      }
      let endLine: number;
      if (slashLine >= 0) {
        endLine = slashLine;
        i = slashLine + 1;
      } else {
        endLine = scanBlockEnd(lines, i);
        i = endLine + 1;
      }
      const blockText = lines.slice(startLine - 1, endLine).join('\n');
      result.push({
        text: blockText,
        startLine,
        isPlsql: true,
        dynamicSnippets: extractDynamicSql(blockText, startLine, file),
      });
      continue;
    }

    // 普通语句:字符级扫描顶层分号
    let parenDepth = 0;
    let inString = false;
    let qquote = false;
    let buf = '';
    let stmtStartLine = i + 1;
    let j = i;
    while (j < lines.length) {
      const ln = lines[j];
      let k = 0;
      while (k < ln.length) {
        const ch = ln[k];
        const next = ln[k + 1];
        if (!inString && ch === "'" && (next === 'q' || next === 'Q') && ln[k + 2] === "'") {
          qquote = true;
          inString = true;
        } else if (ch === "'" && !qquote) {
          if (inString && next === "'") {
            buf += ch;
            k++;
          } else {
            inString = !inString;
          }
        } else if (qquote && ch === "'") {
          qquote = false;
          inString = false;
        }
        if (!inString && ch === '(') parenDepth++;
        else if (!inString && ch === ')') parenDepth--;
        else if (!inString && ch === ';' && parenDepth === 0) {
          const text = buf.trim();
          if (text) result.push({ text, startLine: stmtStartLine, isPlsql: false, dynamicSnippets: [] });
          buf = '';
          parenDepth = 0;
          stmtStartLine = j + 1;
          k++;
          continue;
        }
        buf += ch;
        k++;
      }
      j++;
      if (j < lines.length) buf += '\n';
    }
    const tail = buf.trim();
    if (tail) result.push({ text: tail, startLine: stmtStartLine, isPlsql: false, dynamicSnippets: [] });
    i = j;
  }

  return result;
}

/** 无 "/" 时,按关键字嵌套找块尾(尽力而为) */
function scanBlockEnd(lines: string[], start: number): number {
  const { tokens } = tokenize(lines.slice(start).join('\n'));
  let paren = 0;
  let depth = 0;
  let seenBegin = false;
  for (let t = 0; t < tokens.length; t++) {
    const tk = tokens[t];
    if (tk.type === 'punct' && tk.value === '(') paren++;
    if (tk.type === 'punct' && tk.value === ')') paren--;
    if (paren !== 0 || tk.type !== 'keyword') continue;
    if (tk.value === 'BEGIN' || tk.value === 'DECLARE') {
      depth++;
      seenBegin = true;
    } else if (tk.value === 'IF' || tk.value === 'LOOP') {
      depth++;
    } else if (tk.value === 'END') {
      const after = tokens[t + 1];
      if (after && after.type === 'keyword' && ['IF', 'LOOP', 'CASE'].includes(after.value)) {
        depth--;
        t++;
      } else {
        depth--;
        if (seenBegin && depth <= 0) return start + tk.line - 1;
      }
    }
  }
  return lines.length - 1;
}

/**
 * 从 PL/SQL 块抽取动态 SQL。
 * EXECUTE IMMEDIATE '...' || v_x || '...'
 * v_sql := '...'; EXECUTE IMMEDIATE v_sql;
 * 变量位置统一替换成 ${VAR},交给上层尝试解析;完全由变量构成则标记未识别。
 */
export function extractDynamicSql(block: string, baseLine: number, file?: string): DynamicSqlSnippet[] {
  const { tokens } = tokenize(block);
  const snippets: DynamicSqlSnippet[] = [];
  const varParts = new Map<string, { strings: string[]; hasVar: boolean; line: number }>();

  for (let t = 0; t < tokens.length; t++) {
    const tk = tokens[t];

    // 标识符 := ... 的赋值(":=" 在词法层是两个 op token)
    if (
      tk.type === 'identifier' &&
      tokens[t + 1]?.type === 'op' && tokens[t + 1]?.value === ':' &&
      tokens[t + 2]?.type === 'op' && tokens[t + 2]?.value === '='
    ) {
      const varName = tk.value;
      let p = t + 3;
      const strings: string[] = [];
      let hasVar = false;
      let parenDepth = 0;
      const line = baseLine + tk.line - 1;
      while (p < tokens.length && tokens[p].value !== ';') {
        const cur = tokens[p];
        if (cur.type === 'punct' && cur.value === '(') parenDepth++;
        else if (cur.type === 'punct' && cur.value === ')') parenDepth--;
        // 只把顶层(非函数参数)的字符串当作动态 SQL 片段
        else if (parenDepth === 0 && cur.type === 'string') strings.push(cur.value);
        else if (parenDepth === 0 && (cur.type === 'variable' || cur.type === 'identifier')) hasVar = true;
        p++;
      }
      if (strings.length) varParts.set(varName, { strings, hasVar, line });
      t = p;
      continue;
    }

    if (tk.type === 'keyword' && tk.value === 'EXECUTE' && tokens[t + 1]?.value === 'IMMEDIATE') {
      let p = t + 2;
      const strings: string[] = [];
      let targetVar: string | undefined;
      const startLine = baseLine + tk.line - 1;
      const rawStart = tk.start;
      while (p < tokens.length && tokens[p].value !== ';') {
        const cur = tokens[p];
        if (cur.type === 'string') strings.push(cur.value);
        else if (cur.type === 'identifier' && !targetVar) targetVar = cur.value;
        p++;
      }
      const raw = block.slice(rawStart, tokens[p]?.end ?? rawStart).trim();
      let resolvedSql: string | undefined;
      let reason: string | undefined;
      // 变量位置用 ${VAR} 占位;tokenizer 会把 ${...} 识别为 variable,parser 视作参数表达式
      const PLACEHOLDER = '${VAR}';
      if (targetVar && varParts.has(targetVar)) {
        const stored = varParts.get(targetVar)!;
        resolvedSql = stored.strings.join(PLACEHOLDER);
        if (stored.hasVar) resolvedSql += PLACEHOLDER;
      } else if (strings.length) {
        resolvedSql = strings.join(PLACEHOLDER);
      } else {
        reason = '动态 SQL 完全由变量构成,无法静态还原';
      }
      snippets.push({ file, startLine, raw, resolvedSql, resolved: resolvedSql !== undefined, reason });
      t = p;
    }
  }
  return snippets;
}
