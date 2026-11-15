-- ============================================================
-- 基础层 DDL:Oracle 方言
-- 人工标注的列清单供星号展开与血缘校验使用
-- ============================================================
CREATE TABLE ods_customer (
  cust_id      NUMBER(18),
  cust_name    VARCHAR2(200),
  region       VARCHAR2(64),
  vip_level    NUMBER(4),
  create_time  DATE
);

CREATE TABLE ods_order (
  order_id     NUMBER(18),
  cust_id      NUMBER(18),
  order_amt    NUMBER(18,2),
  discount     NUMBER(10,4),
  currency     VARCHAR2(8),
  fx_rate      NUMBER(18,6),
  order_status VARCHAR2(32),
  order_time   DATE
);

CREATE TABLE ods_order_item (
  item_id      NUMBER(18),
  order_id     NUMBER(18),
  sku_id       NUMBER(18),
  qty          NUMBER(18,2),
  unit_price   NUMBER(18,2)
);

-- 生成列:参与计算的 DDL 内联表达式
CREATE TABLE dim_currency (
  currency     VARCHAR2(8),
  rate_to_cny  NUMBER(18,6),
  rate_double  NUMBER(18,6) GENERATED ALWAYS AS (rate_to_cny * 2) VIRTUAL
);
