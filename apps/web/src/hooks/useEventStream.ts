// 本文件所有改动要求遵循 agent-rules 规范
import { useEffect, useRef } from 'react';

/**
 * 订阅平台 SSE；服务端以终端状态关闭连接，EventSource 会自动重连，
 * 因此页面同时在终态后继续保留轮询作为兜底。回调只触发刷新，不直接信任事件体。
 */
export function useEventStream(url: string | undefined, onEvent: () => void, enabled = true): void {
  const callback = useRef(onEvent);
  callback.current = onEvent;

  useEffect(() => {
    if (!enabled || url === undefined || typeof EventSource === 'undefined') {
      return;
    }

    const source = new EventSource(url);

    source.onmessage = () => {
      callback.current();
    };

    source.onerror = () => {
      // 浏览器自动重连；无需在 UI 中反复提示。
    };

    return () => {
      source.close();
    };
  }, [url, enabled]);
}
