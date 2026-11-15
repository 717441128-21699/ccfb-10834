-- ============================================================
-- rpt_sales 视图:星号展开 + UNION ALL 汇合
-- ============================================================
CREATE OR REPLACE VIEW v_sales_detail AS
SELECT * FROM dws_cust;

CREATE OR REPLACE VIEW rpt_sales AS
SELECT region, total_rmb, 0 AS vip_order_cnt
FROM v_sales_detail
UNION ALL
SELECT region, total_rmb, order_cnt AS vip_order_cnt
FROM dws_cust;
