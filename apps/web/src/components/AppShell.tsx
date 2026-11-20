// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import { App as AntdApp, Avatar, Dropdown, Select, Tag } from 'antd';
import type { MenuProps } from 'antd';
import { FlaskConical, LogOut } from 'lucide-react';
import { Navigate, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import type { TenantRole } from '@gait/shared';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

const ROLE_LABELS: Readonly<Record<TenantRole, string>> = {
  owner: '所有者',
  admin: '管理员',
  developer: '开发者',
  viewer: '只读',
};

const ROLE_COLORS: Readonly<Record<TenantRole, string>> = {
  owner: 'green',
  admin: 'blue',
  developer: 'purple',
  viewer: 'default',
};

export default function AppShell() {
  const { state, logout, switchTenant } = useAuth();
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { tenantSlug } = useParams();
  const [switching, setSwitching] = useState(false);

  if (state.status !== 'authenticated') {
    return null;
  }

  const session = state.session;
  const activeTenant = session.activeTenant;

  if (tenantSlug !== undefined && tenantSlug !== activeTenant.slug) {
    return <Navigate to={`/t/${activeTenant.slug}/projects`} replace />;
  }

  const handleSwitch = async (tenantId: string): Promise<void> => {
    if (tenantId === activeTenant.id) {
      return;
    }

    setSwitching(true);

    try {
      const tenant = await switchTenant(tenantId);
      navigate(`/t/${tenant.slug}/projects`, { replace: true });
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '切换租户失败，请稍后重试');
    } finally {
      setSwitching(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    await logout();
    navigate('/login', { replace: true });
  };

  const menuItems: MenuProps['items'] = [
    {
      key: 'account',
      disabled: true,
      label: (
        <div className="py-1">
          <div className="text-sm font-medium text-gh-text">{session.user.displayName}</div>
          <div className="text-xs text-gh-muted">
            @{session.user.username}
            {session.user.isPlatformAdmin ? ' · 平台管理员' : ''}
          </div>
        </div>
      ),
    },
    { type: 'divider' },
    {
      key: 'logout',
      icon: <LogOut size={14} />,
      label: '退出登录',
    },
  ];

  const navLinkClass = (isActive: boolean): string =>
    `border-b-2 px-1 pb-2 pt-1 text-sm no-underline ${
      isActive
        ? 'border-[#fd8c73] font-semibold text-gh-text'
        : 'border-transparent text-gh-muted hover:border-gh-border hover:text-gh-text'
    }`;

  return (
    <div className="min-h-screen bg-gh-canvas">
      <header className="border-b border-gh-border bg-white">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-3 px-4">
          <NavLink
            to={`/t/${activeTenant.slug}/projects`}
            className="flex items-center gap-2 no-underline"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-gh-green text-white">
              <FlaskConical size={16} />
            </span>
            <span className="text-sm font-semibold text-gh-text">git-ai-test-flow</span>
          </NavLink>

          <span className="h-5 w-px bg-gh-border" />

          <Select
            aria-label="切换租户"
            value={activeTenant.id}
            loading={switching}
            disabled={switching}
            className="min-w-[180px]"
            options={session.tenants.map((tenant) => ({
              value: tenant.id,
              label: tenant.name,
            }))}
            onChange={(tenantId: string) => {
              void handleSwitch(tenantId);
            }}
          />
          <Tag color={ROLE_COLORS[activeTenant.role]} className="!mr-0">
            {ROLE_LABELS[activeTenant.role]}
          </Tag>

          <div className="flex-1" />

          <Dropdown
            menu={{
              items: menuItems,
              onClick: ({ key }) => {
                if (key === 'logout') {
                  void handleLogout();
                }
              },
            }}
            trigger={['click']}
            placement="bottomRight"
          >
            <button
              type="button"
              aria-label="用户菜单"
              className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-gh-canvas"
            >
              <Avatar size={24} className="!bg-gh-green">
                {session.user.displayName.slice(0, 1).toUpperCase()}
              </Avatar>
              <span className="text-sm text-gh-text">{session.user.displayName}</span>
            </button>
          </Dropdown>
        </div>

        <nav className="mx-auto flex max-w-[1280px] gap-5 px-4">
          <NavLink
            to={`/t/${activeTenant.slug}/projects`}
            className={({ isActive }) => navLinkClass(isActive)}
          >
            项目
          </NavLink>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[1280px] px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
