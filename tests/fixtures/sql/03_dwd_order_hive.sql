-- ============================================================
-- dwd_order:CTE + JOIN + 子查询聚合 + 窗口 + CASE + 计算列
-- ============================================================
WITH paid_order AS (
  SELECT
    order_id,
    cust_id,
    order_amt * fx_rate AS rmb_amt_raw,
    order_time
  FROM ods_order
  WHERE order_status = 'PAID'
),
item_agg AS (
  SELECT
    order_id,
    SUM(qty)              AS item_qty,
    COUNT(DISTINCT sku_id) AS sku_cnt
  FROM ods_order_item
  GROUP BY order_id
)
INSERT OVERWRITE TABLE dwd_order
SELECT
  o.order_id,
  o.cust_id,
  c.cust_name,
  c.region,
  CASE
    WHEN o.rmb_amt_raw > 10000 THEN o.rmb_amt_raw * 0.95
    ELSE o.rmb_amt_raw
  END AS rmb_amt,
  ia.item_qty AS item_cnt,
  ROW_NUMBER() OVER (PARTITION BY o.cust_id ORDER BY o.order_time DESC) AS rn
FROM paid_order o
JOIN ods_customer c ON o.cust_id = c.cust_id
LEFT JOIN item_agg ia ON o.order_id = ia.order_id;
