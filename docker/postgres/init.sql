-- 初始化独立的 LangGraph checkpoint 数据库；业务库由 POSTGRES_DB 自动创建。
-- 仅在数据卷首次初始化时执行一次。
SELECT 'CREATE DATABASE gait_checkpoints'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gait_checkpoints')\gexec
