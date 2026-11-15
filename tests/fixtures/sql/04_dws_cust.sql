-- ============================================================
-- dws_cust:聚合 + CASE 标签 + 原样搬运
-- ============================================================
INSERT INTO dws_cust (cust_id, cust_name, region, total_rmb, order_cnt, vip_tag)
SELECT
  d.cust_id,
  MAX(d.cust_name) AS cust_name,
  MAX(d.region)    AS region,
  SUM(d.rmb_amt)   AS total_rmb,
  COUNT(1)         AS order_cnt,
  CASE WHEN SUM(d.rmb_amt) >= 100000 THEN 'VIP' ELSE 'NORMAL' END AS vip_tag
FROM dwd_order d
GROUP BY d.cust_id;
