-- ============================================================
-- LATERAL VIEW explode(Hive 数组展开)+ 星号限定
-- ============================================================
INSERT OVERWRITE TABLE dwd_event_tags
SELECT
  e.event_id,
  e.order_id,
  t.tag
FROM ods_event e
LATERAL VIEW OUTER explode(e.tags) t AS tag;
