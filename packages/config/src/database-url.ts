// 本文件所有改动要求遵循 agent-rules 规范

/**
 * 归一化 PostgreSQL 连接目标：忽略协议、用户名与密码，缺省端口按 5432 处理。
 * 返回 `host:port/database`，无法解析时返回 null。
 */
export function databaseIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      return null;
    }

    const port = parsed.port.length > 0 ? parsed.port : '5432';
    const database = parsed.pathname.replace(/^\/+/, '');

    return `${parsed.hostname.toLowerCase()}:${port}/${database}`;
  } catch {
    return null;
  }
}

/** 业务库与 LangGraph checkpoint 库必须指向不同的 host/port/database。 */
export function assertSeparateDatabaseUrls(
  databaseUrl: string,
  checkpointDatabaseUrl: string,
): void {
  const appTarget = databaseIdentity(databaseUrl);
  const checkpointTarget = databaseIdentity(checkpointDatabaseUrl);

  if (
    databaseUrl === checkpointDatabaseUrl ||
    (appTarget !== null && appTarget === checkpointTarget)
  ) {
    throw new Error('DATABASE_URL and CHECKPOINT_DATABASE_URL must point to different databases');
  }
}
