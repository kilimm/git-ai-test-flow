// 本文件所有改动要求遵循 agent-rules 规范
import { useCallback, useEffect, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
  reload: () => void;
}

/**
 * 页面统一请求状态：集中处理 loading/error/retry，
 * 业务组件不在事件回调里重复写 try-catch。
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError(undefined);
    loader().then(
      (result) => {
        if (active) {
          setData(result);
          setLoading(false);
        }
      },
      (cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setLoading(false);
        }
      },
    );

    return () => {
      active = false;
    };
    // loader 每次渲染都会变化，由调用方声明的 deps 控制刷新时机。
  }, [...deps, version]);

  return { data, loading, error, reload };
}
