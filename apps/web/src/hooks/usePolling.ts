// 本文件所有改动要求遵循 agent-rules 规范
import { useEffect } from 'react';

/** P0 轮询：生成/运行详情在未进入终态时按固定间隔刷新。 */
export function usePolling(callback: () => void, intervalMs: number, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const timer = setInterval(callback, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [callback, intervalMs, enabled]);
}
