-- ============================================================
-- 标量子查询 + CAST + 字符串拼接 + Oracle q-quote
-- ============================================================
CREATE TABLE rpt_cust_enriched (
  cust_id     BIGINT,
  display_name STRING,
  first_order_amt DECIMAL(18,2)
);

INSERT INTO rpt_cust_enriched (cust_id, display_name, first_order_amt)
SELECT
  c.cust_id,
  c.cust_name || q'[ (]' || c.region || q'[)]' AS display_name,
  CAST(
    (SELECT MIN(o.order_amt) FROM ods_order o WHERE o.cust_id = c.cust_id)
    AS DECIMAL(18,2)
  ) AS first_order_amt
FROM ods_customer c;
