# 列级血缘追踪平台(Column-Level Lineage Tracker)

浏览器端的 Oracle / Hive SQL 列级血缘分析工具。本地导入 SQL 脚本,自动解析建表、插入、
视图、CTE、子查询、窗口函数、UNION 等语法,构建细到列的血缘图,支持影响分析与新旧脚本
算法变更比对。所有解析在浏览器内完成,SQL 文件不上传任何服务。

## 能力对照(需求覆盖)

| # | 需求 | 实现 |
|---|------|------|
| 1 | Oracle/Hive 双方言,建表/插入/视图/CTE/子查询/窗口/UNION | 自研 tokenizer + 递归下降 parser,见 `src/parser/` |
| 2 | 列级血缘,区分原样搬运与参与计算 | 边带 `transform`:direct / compute / aggregate / window / constant |
| 3 | 星号展开靠 DDL 推导列清单 | Pass1 注册全部 DDL schema,`expandStar` 按表列清单展开 |
| 4 | 动态 SQL 能识别就识别,识别不了单列 | `splitter.extractDynamicSql`,已还原的纳入血缘,不可还原进问题清单 |
| 5 | 点列看上下游、图可折叠、几千节点不卡 | Cytoscape 按需渲染邻域子图 + 表级骨架,深度可调 |
| 6 | 假设改列,列出受波及报表列与加工路径 | `analyzeImpact` 传递闭包 + BFS 路径,影响分析页 |
| 7 | 新旧脚本比对,算法变更列标红 | `diffGraphs`,expression-changed 标红 |
| — | 列级召回率/准确率 ≥ 95% | 实测均 **100%**(62 条人工标注全闭包答案) |

## 架构

```
SQL 文件
  │
  ▼
splitter      语句切分:顶层分号 / PL-SQL 块(/) / 动态 SQL 抽取
  │
  ▼
tokenizer     词法:Oracle q-quote、Hive ${var}、反引号、双引号标识符、绑定变量
  │
  ▼
parser        递归下降 → 类型化 AST(SELECT/CTE/JOIN/窗口/UNION/DDL/INSERT/MERGE)
  │
  ▼
analyzer      两趟:① 注册 DDL schema ② 逐语句构建列级血缘(作用域解析、星号展开、
              子查询独立作用域、窗口分区列、LATERAL explode、生成列)
  │
  ▼
LineageGraph  列节点 + 表节点 + 带 transform/expression 的有向边
  │
  ├─ impact.ts    影响分析(传递闭包+路径)、上游溯源、physicalLineage 闭包压缩、diff
  └─ UI(React + zustand + Cytoscape)
```

### 关键设计

- **不依赖通用 SQL 解析库**:node-sql-parser 等对 Hive 方言、PL/SQL 过程体、动态 SQL
  支持薄弱且 AST 不为血缘设计。本项目自研解析器只覆盖血缘所需语法子集,每条边的
  transform 语义可精确控制。
- **合成列中转**:每个 SELECT 产出先落到内部 `__SEL_n` 合成表,再由 INSERT/视图绑定到
  真实表。`physicalLineage` 负责把穿过合成列与中间视图的路径压缩成物理列→物理列传递边,
  transform 取路径上最强语义(window > aggregate > compute > direct)。
- **子查询作用域隔离**:`collectColumnRefs` 不穿透子查询边界,标量子查询由分析器用其
  自身 FROM 作用域单独解析;相关子查询的外层关联列用外层作用域解析。
- **动态 SQL**:识别 `v := '...' || var` 赋值与 `EXECUTE IMMEDIATE`,变量位置用 `${VAR}`
  占位(词法层识别为变量、语法层视为参数表达式);完全由变量构成、无法静态还原的,
  标记 `resolved=false` 单列到问题清单。

## 目录结构

```
src/
  parser/        tokenizer / splitter / parser / AST 与 token 类型
  lineage/       analyzer(核心)、expr-tools、impact、serialize、图谱类型
  engine.ts      编排:方言识别 → 解析 → 血缘
  workers/       Web Worker 封装(大文件解析不阻塞 UI)
  components/    React 页面:血缘图/影响分析/算法比对/问题清单/脚本库
  store.ts       zustand 全局状态
tests/
  fixtures/sql/        9 个覆盖全部语法点的脚本(Oracle + Hive)
  fixtures/golden-lineage.ts  人工标注的 62 条列级血缘答案
  eval/lineage-eval.test.ts  召回率/精确率/加工类型评测
  unit/                  语法点单测、影响分析、diff、端到端集成
```

## 使用

```bash
npm install
npm run dev        # 启动开发服务器,浏览器打开后拖拽导入 SQL 文件
npm test           # 运行全部 30 项测试
npm run eval       # 只跑列级血缘指标评测
npm run build      # 类型检查 + 生产构建
```

导入支持 `.sql / .hql / .ddl / .prc / .pls`,可多选;方言按脚本特征自动识别,
也可在文件上显式指定。

## 测试与指标

`tests/fixtures/sql` 的 9 个脚本覆盖:DDL(含生成列)、Hive 外部表、CTE 多层、
JOIN、子查询聚合、窗口函数、CASE、UNION ALL、星号展开、LATERAL VIEW explode、
MERGE、Oracle PL/SQL 动态 SQL(可还原/不可还原各一)、q-quote 字符串拼接、标量子查询。

评测口径与结果(`npm run eval`):

- 列级**召回率 100%**(62/62 人工标注边全部命中)
- 列级**精确率 100%**(引擎产出的 62 条物理传递边全部正确,无误报)
- **加工类型判定 100%**(direct/compute/aggregate/window 逐条核对)
- 动态 SQL:1 条成功还原并纳入血缘,1 条不可还原正确单列
- 解析零致命错误

## 已知边界

- 解析目标是血缘而非完整 SQL 执行,存储过程内的命令式逻辑(循环、条件分支控制流)
  不建模,只抽取其中的动态 SQL。
- 动态 SQL 仅支持字符串字面量拼接的静态还原;运行时才拼出的 SQL 无法获知,按设计单列待人工确认。
- 宏/临时表、跨库三段名按标识符归一化处理;方言专有函数按通用函数调用统一建边。
- 递归 CTE 的递归项不展开迭代,仅建立锚点与引用列的血缘。
