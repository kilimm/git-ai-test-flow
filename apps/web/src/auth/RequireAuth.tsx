// 本文件所有改动要求遵循 agent-rules 规范
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth } from './AuthProvider';

export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <Spin size="large" />
        <span className="text-sm text-gh-muted">正在加载会话…</span>
      </div>
    );
  }

  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
