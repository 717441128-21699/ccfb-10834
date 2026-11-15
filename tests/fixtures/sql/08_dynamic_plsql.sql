-- ============================================================
-- Oracle PL/SQL 动态 SQL
-- 过程 p_resolvable:字符串拼接,可静态还原
-- 过程 p_dark:完全由变量/函数构成,识别不了应单列
-- ============================================================
CREATE OR REPLACE PROCEDURE p_resolvable(p_region IN VARCHAR2)
AS
  v_sql VARCHAR2(4000);
BEGIN
  v_sql := 'INSERT INTO dim_cust_snapshot(cust_id, cust_name, region) SELECT cust_id, cust_name, region FROM ods_customer WHERE region = ' || p_region;
  EXECUTE IMMEDIATE v_sql;
END;
/

CREATE OR REPLACE PROCEDURE p_dark
AS
  v_sql VARCHAR2(4000);
BEGIN
  v_sql := load_config('dark_sql');
  EXECUTE IMMEDIATE v_sql;
END;
/
