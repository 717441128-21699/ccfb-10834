-- ============================================================
-- MERGE:目标列更新与插入的血缘
-- ============================================================
MERGE INTO dim_cust_snapshot t
USING (
  SELECT cust_id, cust_name, region
  FROM ods_customer
) s
ON (t.cust_id = s.cust_id)
WHEN MATCHED THEN
  UPDATE SET
    t.cust_name = s.cust_name,
    t.region    = s.region
WHEN NOT MATCHED THEN
  INSERT (cust_id, cust_name, region)
  VALUES (s.cust_id, s.cust_name, s.region);
