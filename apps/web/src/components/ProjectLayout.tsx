// 本文件所有改动要求遵循 agent-rules 规范
import { createContext, useContext } from 'react';
import { Button, Result, Skeleton } from 'antd';
import {
  BookOpen,
  FlaskConical,
  GitPullRequest,
  LayoutDashboard,
  PlayCircle,
  Settings,
} from 'lucide-react';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Project } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { useAsync } from '../hooks/useAsync';
import ErrorState from './ErrorState';

export interface ProjectContextValue {
  project: Project;
  reloadProject: () => void;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext);

  if (context === undefined) {
    throw new Error('useProject must be used within ProjectLayout');
  }

  return context;
}

const NAV_ITEMS = [
  { suffix: 'overview', label: '概览', icon: LayoutDashboard },
  { suffix: 'changes', label: '变更与生成', icon: GitPullRequest },
  { suffix: 'tests', label: '用例', icon: FlaskConical },
  { suffix: 'runs', label: '运行', icon: PlayCircle },
  { suffix: 'docs', label: '文档', icon: BookOpen },
  { suffix: 'settings', label: '设置', icon: Settings },
] as const;

export default function ProjectLayout() {
  const { state } = useAuth();
  const { projectSlug } = useParams();
  const tenantId = state.status === 'authenticated' ? state.session.activeTenant.id : '';
  const tenantSlug = state.status === 'authenticated' ? state.session.activeTenant.slug : '';
  const { data, loading, error, reload } = useAsync(
    () => api.listProjects(tenantId),
    [tenantId, state.status],
  );

  if (state.status !== 'authenticated') {
    return null;
  }

  if (loading && data === undefined) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }

  if (error !== undefined) {
    return <ErrorState error={error} onRetry={reload} />;
  }

  const project = data?.find((item) => item.slug === projectSlug);

  if (project === undefined) {
    return (
      <Result
        status="404"
        title="项目不存在"
        subTitle="项目可能已被删除，或当前租户没有访问权限。"
        extra={
          <Link to={`/t/${tenantSlug}/projects`}>
            <Button type="primary">返回项目列表</Button>
          </Link>
        }
      />
    );
  }

  const base = `/t/${tenantSlug}/p/${project.slug}`;

  return (
    <ProjectContext.Provider value={{ project, reloadProject: reload }}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-gh-muted">
              <span>{state.session.activeTenant.name}</span>
              <span>/</span>
              <span className="truncate">{project.name}</span>
            </div>
            <h1 className="mt-1 text-2xl font-semibold text-gh-text">{project.name}</h1>
            <p className="mt-1 text-sm text-gh-muted">
              <code className="font-mono">{project.productRepoUrl}</code>
              <span className="mx-2">·</span>
              <code className="font-mono">{project.defaultBranch}</code>
              <span className="mx-2">·</span>
              Suite: {project.suiteMode}
            </p>
          </div>
          <div className="flex gap-2">
            <Link to={`${base}/changes`}>
              <Button icon={<GitPullRequest size={15} />}>生成用例</Button>
            </Link>
            <Link to={`${base}/runs`}>
              <Button type="primary" icon={<PlayCircle size={15} />}>
                查看运行
              </Button>
            </Link>
          </div>
        </div>

        <nav className="flex flex-wrap gap-5 border-b border-gh-border">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;

            return (
              <NavLink
                key={item.suffix}
                to={`${base}/${item.suffix}`}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 border-b-2 px-1 pb-2 text-sm no-underline ${
                    isActive
                      ? 'border-[#fd8c73] font-semibold text-gh-text'
                      : 'border-transparent text-gh-muted hover:border-gh-border hover:text-gh-text'
                  }`
                }
              >
                <Icon size={15} />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <Outlet />
      </div>
    </ProjectContext.Provider>
  );
}
