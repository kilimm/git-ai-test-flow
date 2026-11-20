// 本文件所有改动要求遵循 agent-rules 规范
import { Navigate, Route, Routes } from 'react-router-dom';
import { App, Spin } from 'antd';
import AppShell from './components/AppShell';
import { RequireAuth } from './auth/RequireAuth';
import { useAuth } from './auth/AuthProvider';
import LoginPage from './pages/LoginPage';
import NotFoundPage from './pages/NotFoundPage';
import ProjectsPage from './pages/ProjectsPage';

function RootRedirect() {
  const { state } = useAuth();

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spin size="large" />
      </div>
    );
  }

  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to={`/t/${state.session.activeTenant.slug}/projects`} replace />;
}

export default function AppRoutes() {
  return (
    <App>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route element={<RequireAuth />}>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/t/:tenantSlug" element={<RootRedirect />} />
          <Route element={<AppShell />}>
            <Route path="/t/:tenantSlug/projects" element={<ProjectsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </App>
  );
}
