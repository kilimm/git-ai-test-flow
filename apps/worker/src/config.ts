// 本文件所有改动要求遵循 agent-rules 规范
import { assertSeparateDatabaseUrls } from '@gait/config';

/**
 * LangGraph checkpoint 必须使用独立数据库。这里在启动阶段拦截同一连接目标，
 * 避免 checkpoint 表与业务表混用后出现锁竞争和迁移污染。
 * 连接串中的协议、用户名/密码不参与比较，只比较 host、port 与 database。
 */
export function assertSeparateDatabases(databaseUrl: string, checkpointDatabaseUrl: string): void {
  assertSeparateDatabaseUrls(databaseUrl, checkpointDatabaseUrl);
}
