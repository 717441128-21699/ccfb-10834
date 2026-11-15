// ============================================================
// 人工标注的列级血缘 golden answer(完整传递闭包口径)
//
// 评估口径:
//   - 引擎产出物理列 -> 物理列 的"传递边"(穿透内部合成列与中间视图/表),
//     一条边表示"源列经任意多跳加工后可到达目标列"。
//   - transform 取该路径上最强的加工语义:window > aggregate > compute > direct。
//     例:源列先被 MAX 聚合再透传进视图,该传递边标 aggregate。
//   - constant 边(无物理源)不在此表,由常量测试单独覆盖。
//
// 下表逐行人工核对自 tests/fixtures/sql 下 9 个脚本,共 62 条。
// ============================================================

export interface GoldenEdge {
  source: string; // 表::列(大写)
  target: string;
  transform: 'direct' | 'compute' | 'aggregate' | 'window' | 'constant';
}

export const GOLDEN_EDGES: GoldenEdge[] = [
  // ---- DDL 生成列(01)----
  { source: 'DIM_CURRENCY::RATE_TO_CNY', target: 'DIM_CURRENCY::RATE_DOUBLE', transform: 'compute' },

  // ---- dwd_order(03):CTE + JOIN + 窗口 + CASE ----
  { source: 'ODS_ORDER::ORDER_ID', target: 'DWD_ORDER::ORDER_ID', transform: 'direct' },
  { source: 'ODS_ORDER::CUST_ID', target: 'DWD_ORDER::CUST_ID', transform: 'direct' },
  { source: 'ODS_CUSTOMER::CUST_NAME', target: 'DWD_ORDER::CUST_NAME', transform: 'direct' },
  { source: 'ODS_CUSTOMER::REGION', target: 'DWD_ORDER::REGION', transform: 'direct' },
  { source: 'ODS_ORDER::ORDER_AMT', target: 'DWD_ORDER::RMB_AMT', transform: 'compute' },
  { source: 'ODS_ORDER::FX_RATE', target: 'DWD_ORDER::RMB_AMT', transform: 'compute' },
  { source: 'ODS_ORDER_ITEM::QTY', target: 'DWD_ORDER::ITEM_CNT', transform: 'aggregate' },
  { source: 'ODS_ORDER::ORDER_TIME', target: 'DWD_ORDER::RN', transform: 'window' },
  { source: 'ODS_ORDER::CUST_ID', target: 'DWD_ORDER::RN', transform: 'window' },

  // ---- dws_cust(04):聚合,含从 ods 穿透 dwd 的传递边 ----
  { source: 'DWD_ORDER::CUST_ID', target: 'DWS_CUST::CUST_ID', transform: 'direct' },
  { source: 'ODS_ORDER::CUST_ID', target: 'DWS_CUST::CUST_ID', transform: 'direct' },
  { source: 'DWD_ORDER::CUST_NAME', target: 'DWS_CUST::CUST_NAME', transform: 'aggregate' },
  { source: 'ODS_CUSTOMER::CUST_NAME', target: 'DWS_CUST::CUST_NAME', transform: 'aggregate' },
  { source: 'DWD_ORDER::REGION', target: 'DWS_CUST::REGION', transform: 'aggregate' },
  { source: 'ODS_CUSTOMER::REGION', target: 'DWS_CUST::REGION', transform: 'aggregate' },
  { source: 'DWD_ORDER::RMB_AMT', target: 'DWS_CUST::TOTAL_RMB', transform: 'aggregate' },
  { source: 'ODS_ORDER::ORDER_AMT', target: 'DWS_CUST::TOTAL_RMB', transform: 'aggregate' },
  { source: 'ODS_ORDER::FX_RATE', target: 'DWS_CUST::TOTAL_RMB', transform: 'aggregate' },
  { source: 'DWD_ORDER::RMB_AMT', target: 'DWS_CUST::VIP_TAG', transform: 'compute' },
  { source: 'ODS_ORDER::ORDER_AMT', target: 'DWS_CUST::VIP_TAG', transform: 'compute' },
  { source: 'ODS_ORDER::FX_RATE', target: 'DWS_CUST::VIP_TAG', transform: 'compute' },

  // ---- rpt_sales(05):UNION ALL + 视图,含完整传递闭包 ----
  { source: 'V_SALES_DETAIL::REGION', target: 'RPT_SALES::REGION', transform: 'direct' },
  { source: 'DWS_CUST::REGION', target: 'RPT_SALES::REGION', transform: 'direct' },
  { source: 'DWD_ORDER::REGION', target: 'RPT_SALES::REGION', transform: 'aggregate' },
  { source: 'ODS_CUSTOMER::REGION', target: 'RPT_SALES::REGION', transform: 'aggregate' },
  { source: 'V_SALES_DETAIL::TOTAL_RMB', target: 'RPT_SALES::TOTAL_RMB', transform: 'direct' },
  { source: 'DWS_CUST::TOTAL_RMB', target: 'RPT_SALES::TOTAL_RMB', transform: 'direct' },
  { source: 'DWD_ORDER::RMB_AMT', target: 'RPT_SALES::TOTAL_RMB', transform: 'aggregate' },
  { source: 'ODS_ORDER::ORDER_AMT', target: 'RPT_SALES::TOTAL_RMB', transform: 'aggregate' },
  { source: 'ODS_ORDER::FX_RATE', target: 'RPT_SALES::TOTAL_RMB', transform: 'aggregate' },
  { source: 'DWS_CUST::ORDER_CNT', target: 'RPT_SALES::VIP_ORDER_CNT', transform: 'direct' },

  // ---- LATERAL VIEW(06)----
  { source: 'ODS_EVENT::EVENT_ID', target: 'DWD_EVENT_TAGS::EVENT_ID', transform: 'direct' },
  { source: 'ODS_EVENT::ORDER_ID', target: 'DWD_EVENT_TAGS::ORDER_ID', transform: 'direct' },
  { source: 'ODS_EVENT::TAGS', target: 'DWD_EVENT_TAGS::TAG', transform: 'compute' },

  // ---- MERGE(07)+ 动态 SQL(08)同一目标 ----
  { source: 'ODS_CUSTOMER::CUST_ID', target: 'DIM_CUST_SNAPSHOT::CUST_ID', transform: 'direct' },
  { source: 'ODS_CUSTOMER::CUST_NAME', target: 'DIM_CUST_SNAPSHOT::CUST_NAME', transform: 'direct' },
  { source: 'ODS_CUSTOMER::REGION', target: 'DIM_CUST_SNAPSHOT::REGION', transform: 'direct' },

  // ---- 标量子查询 + 拼接 + CAST(09)----
  { source: 'ODS_CUSTOMER::CUST_ID', target: 'RPT_CUST_ENRICHED::CUST_ID', transform: 'direct' },
  { source: 'ODS_CUSTOMER::CUST_NAME', target: 'RPT_CUST_ENRICHED::DISPLAY_NAME', transform: 'compute' },
  { source: 'ODS_CUSTOMER::REGION', target: 'RPT_CUST_ENRICHED::DISPLAY_NAME', transform: 'compute' },
  { source: 'ODS_ORDER::CUST_ID', target: 'RPT_CUST_ENRICHED::FIRST_ORDER_AMT', transform: 'aggregate' },
  { source: 'ODS_CUSTOMER::CUST_ID', target: 'RPT_CUST_ENRICHED::FIRST_ORDER_AMT', transform: 'compute' },
  { source: 'ODS_ORDER::ORDER_AMT', target: 'RPT_CUST_ENRICHED::FIRST_ORDER_AMT', transform: 'aggregate' },

  // ---- v_sales_detail(05):星号展开视图,逐列透传 + 上游穿透 ----
  { source: 'DWS_CUST::CUST_ID', target: 'V_SALES_DETAIL::CUST_ID', transform: 'direct' },
  { source: 'DWD_ORDER::CUST_ID', target: 'V_SALES_DETAIL::CUST_ID', transform: 'direct' },
  { source: 'ODS_ORDER::CUST_ID', target: 'V_SALES_DETAIL::CUST_ID', transform: 'direct' },
  { source: 'DWS_CUST::CUST_NAME', target: 'V_SALES_DETAIL::CUST_NAME', transform: 'direct' },
  { source: 'DWD_ORDER::CUST_NAME', target: 'V_SALES_DETAIL::CUST_NAME', transform: 'aggregate' },
  { source: 'ODS_CUSTOMER::CUST_NAME', target: 'V_SALES_DETAIL::CUST_NAME', transform: 'aggregate' },
  { source: 'DWS_CUST::REGION', target: 'V_SALES_DETAIL::REGION', transform: 'direct' },
  { source: 'DWD_ORDER::REGION', target: 'V_SALES_DETAIL::REGION', transform: 'aggregate' },
  { source: 'ODS_CUSTOMER::REGION', target: 'V_SALES_DETAIL::REGION', transform: 'aggregate' },
  { source: 'DWS_CUST::TOTAL_RMB', target: 'V_SALES_DETAIL::TOTAL_RMB', transform: 'direct' },
  { source: 'DWD_ORDER::RMB_AMT', target: 'V_SALES_DETAIL::TOTAL_RMB', transform: 'aggregate' },
  { source: 'ODS_ORDER::ORDER_AMT', target: 'V_SALES_DETAIL::TOTAL_RMB', transform: 'aggregate' },
  { source: 'ODS_ORDER::FX_RATE', target: 'V_SALES_DETAIL::TOTAL_RMB', transform: 'aggregate' },
  { source: 'DWS_CUST::ORDER_CNT', target: 'V_SALES_DETAIL::ORDER_CNT', transform: 'direct' },
  { source: 'DWS_CUST::VIP_TAG', target: 'V_SALES_DETAIL::VIP_TAG', transform: 'direct' },
  { source: 'DWD_ORDER::RMB_AMT', target: 'V_SALES_DETAIL::VIP_TAG', transform: 'compute' },
  { source: 'ODS_ORDER::ORDER_AMT', target: 'V_SALES_DETAIL::VIP_TAG', transform: 'compute' },
  { source: 'ODS_ORDER::FX_RATE', target: 'V_SALES_DETAIL::VIP_TAG', transform: 'compute' },
];

/** 去重后的期望边键(同 source/target 跨语句只算一条) */
export const GOLDEN_EDGE_KEYS = new Set(GOLDEN_EDGES.map((e) => `${e.source}->${e.target}`));

/** 期望被识别为"无法静态还原、需单列"的动态 SQL 数量 */
export const EXPECTED_UNRESOLVED_DYNAMIC = 1;

/** 期望成功还原的动态 SQL 片段数量 */
export const EXPECTED_RESOLVED_DYNAMIC = 1;
