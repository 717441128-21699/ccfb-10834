-- ============================================================
-- Hive 方言 DDL
-- ============================================================
CREATE EXTERNAL TABLE IF NOT EXISTS dwd_order (
  order_id   BIGINT,
  cust_id    BIGINT,
  cust_name  STRING,
  region     STRING,
  rmb_amt    DECIMAL(18,2),
  item_cnt   BIGINT,
  rn         BIGINT
) STORED AS ORC;

CREATE TABLE dws_cust (
  cust_id    BIGINT,
  cust_name  STRING,
  region     STRING,
  total_rmb  DECIMAL(18,2),
  order_cnt  BIGINT,
  vip_tag    STRING
);

CREATE TABLE rpt_sales (
  region          STRING,
  total_rmb       DECIMAL(18,2),
  vip_order_cnt   BIGINT
);

-- LATERAL VIEW 用:含数组列
CREATE TABLE ods_event (
  event_id   BIGINT,
  order_id   BIGINT,
  tags       ARRAY<STRING>
);

CREATE TABLE dwd_event_tags (
  event_id   BIGINT,
  order_id   BIGINT,
  tag        STRING
);

-- MERGE 目标表
CREATE TABLE dim_cust_snapshot (
  cust_id    BIGINT,
  cust_name  STRING,
  region     STRING
);
