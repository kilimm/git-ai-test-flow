// 本文件所有改动要求遵循 agent-rules 规范
import { Navigate, Route, Routes } from 'react-router-dom';
import { App, Spin } from 'antd';
import AppShell from './components/AppShell';
import ErrorBoundary from './components/ErrorBoundary';
import ProjectLayout from './components/ProjectLayout';
import SettingsLayout from './components/SettingsLayout';
import { RequireAuth } from './auth/RequireAuth';
import { useAuth } from './auth/AuthProvider';
import AuditPage from './pages/AuditPage';
import LoginPage from './pages/LoginPage';
import NotFoundPage from './pages/NotFoundPage';
import ProjectsPage from './pages/ProjectsPage';
import CasesPage from './pages/project/CasesPage';
import DocsPage from './pages/project/DocsPage';
import GenerationPage from './pages/project/GenerationPage';
import ProjectOverviewPage from './pages/project/ProjectOverviewPage';
import RunCasePage from './pages/project/RunCasePage';
import RunDetailPage from './pages/project/RunDetailPage';
import RunsPage from './pages/project/RunsPage';
import EnvironmentsSettingsPage from './pages/project/settings/EnvironmentsSettingsPage';
import GeneralSettingsPage from './pages/project/settings/GeneralSettingsPage';
import GitSettingsPage from './pages/project/settings/GitSettingsPage';
import LlmSettingsPage from './pages/project/settings/LlmSettingsPage';
import MembersSettingsPage from './pages/project/settings/MembersSettingsPage';
import NotificationsSettingsPage from './pages/project/settings/NotificationsSettingsPage';

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
      <ErrorBoundary>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<RequireAuth />}>
            <Route path="/" element={<RootRedirect />} />
            <Route path="/t/:tenantSlug" element={<RootRedirect />} />
            <Route element={<AppShell />}>
              <Route path="/t/:tenantSlug/projects" element={<ProjectsPage />} />
              <Route path="/t/:tenantSlug/audit" element={<AuditPage />} />

              <Route path="/t/:tenantSlug/p/:projectSlug" element={<ProjectLayout />}>
                <Route index element={<Navigate to="overview" replace />} />
                <Route path="overview" element={<ProjectOverviewPage />} />
                <Route path="changes" element={<GenerationPage />} />
                <Route path="tests" element={<CasesPage />} />
                <Route path="docs" element={<DocsPage />} />
                <Route path="runs" element={<RunsPage />} />
                <Route path="runs/:runId" element={<RunDetailPage />} />
                <Route path="runs/:runId/cases/:caseId" element={<RunCasePage />} />
                <Route path="settings" element={<SettingsLayout />}>
                  <Route index element={<Navigate to="general" replace />} />
                  <Route path="general" element={<GeneralSettingsPage />} />
                  <Route path="git" element={<GitSettingsPage />} />
                  <Route path="environments" element={<EnvironmentsSettingsPage />} />
                  <Route path="llm" element={<LlmSettingsPage />} />
                  <Route path="notifications" element={<NotificationsSettingsPage />} />
                  <Route path="members" element={<MembersSettingsPage />} />
                </Route>
              </Route>
            </Route>
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </ErrorBoundary>
    </App>
  );
}
