import { Parser } from './parser/parser';
import { splitStatements } from './parser/splitter';
import { Dialect, DynamicSqlSnippet, Program } from './parser/types';
import { LineageAnalyzer } from './lineage/analyzer';
import { LineageGraph } from './lineage/types';

export interface SqlFile {
  name: string;
  content: string;
  dialect?: Dialect;
}

export interface EngineResult {
  graph: LineageGraph;
  fileCount: number;
  statementCount: number;
  dynamicSql: DynamicSqlSnippet[];
}

const HIVE_HINTS = [/\bINSERT\s+OVERWRITE\b/i, /\bLATERAL\s+VIEW\b/i, /\bTBLPROPERTIES\b/i, /\$\{/];
const ORACLE_HINTS = [/\bVARCHAR2\b/i, /\bNVL\s*\(/i, /\bDECODE\s*\(/i, /\bEXECUTE\s+IMMEDIATE\b/i, /\bMINUS\b/i];

export function detectDialect(content: string): Dialect {
  const hiveScore = HIVE_HINTS.reduce((s, re) => s + (re.test(content) ? 1 : 0), 0);
  const oracleScore = ORACLE_HINTS.reduce((s, re) => s + (re.test(content) ? 1 : 0), 0);
  if (hiveScore > oracleScore) return 'hive';
  if (oracleScore > hiveScore) return 'oracle';
  return 'generic';
}

/** 单文件解析:普通 SQL 走 parser,PL/SQL 块抽取动态 SQL 后尝试解析 */
export function parseFile(file: SqlFile): { program: Program; file: string; dialect: Dialect } {
  const dialect = file.dialect ?? detectDialect(file.content);
  const raws = splitStatements(file.content, file.name);
  const parser = new Parser();
  const combined: Program = { statements: [], plsqlBlocks: 0, dynamicSql: [], issues: [] };

  for (const raw of raws) {
    if (raw.isPlsql) {
      combined.plsqlBlocks++;
      for (const snip of raw.dynamicSnippets) {
        combined.dynamicSql.push(snip);
        if (snip.resolved && snip.resolvedSql) {
          try {
            const sub = new Parser().parseProgram(snip.resolvedSql, dialect);
            combined.statements.push(...sub.statements);
            if (!sub.statements.length) {
              combined.issues.push({
                code: 'UNRESOLVED_DYNAMIC',
                message: '动态 SQL 还原后仍无法完整解析,需人工确认',
                severity: 'warn',
                file: file.name,
                startLine: snip.startLine,
                snippet: snip.resolvedSql,
              });
            }
          } catch {
            combined.issues.push({
              code: 'UNRESOLVED_DYNAMIC',
              message: '动态 SQL 含变量占位,无法静态解析',
              severity: 'warn',
              file: file.name,
              startLine: snip.startLine,
              snippet: snip.resolvedSql,
            });
          }
        } else {
          combined.issues.push({
            code: 'DYNAMIC_SQL',
            message: snip.reason ?? '动态 SQL 无法静态识别,已单列',
            severity: 'warn',
            file: file.name,
            startLine: snip.startLine,
            snippet: snip.raw,
          });
        }
      }
      continue;
    }
    try {
      const sub = parser.parseProgram(raw.text, dialect);
      combined.statements.push(...sub.statements);
      combined.issues.push(...sub.issues);
    } catch (e) {
      combined.issues.push({
        code: 'PARSE_ERROR',
        message: e instanceof Error ? e.message : String(e),
        severity: 'error',
        file: file.name,
        startLine: raw.startLine,
        snippet: raw.text.slice(0, 200),
      });
    }
  }

  return { program: combined, file: file.name, dialect };
}

export function buildLineage(files: SqlFile[]): EngineResult {
  const parsed = files.map(parseFile);
  const analyzer = new LineageAnalyzer();
  const graph = analyzer.analyze(parsed);
  const statementCount = parsed.reduce((n, p) => n + p.program.statements.length, 0);
  const dynamicSql = parsed.flatMap((p) => p.program.dynamicSql);
  return { graph, fileCount: files.length, statementCount, dynamicSql };
}
