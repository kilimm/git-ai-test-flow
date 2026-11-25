// 本文件所有改动要求遵循 agent-rules 规范
import { Alert, Tabs } from 'antd';
import {
  Bell,
  Database,
  FileCog,
  GitBranch,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  Webhook,
} from 'lucide-react';
import { Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { PERMISSION } from '@gait/shared';
import { useAuth } from '../auth/AuthProvider';
import { hasPermission } from '../api/client';
import { useProject } from './ProjectLayout';

export default function SettingsLayout() {
  const { state } = useAuth();
  const { project } = useProject();
  const navigate = useNavigate();
  const location = useLocation();
  const { tenantSlug } = useParams();

  if (state.status !== 'authenticated') {
    return null;
  }

  const permissions = state.session.permissions;
  const tabs = [
    {
      key: 'general',
      label: '常规',
      icon: <Settings2 size={14} />,
      visible: hasPermission(permissions, PERMISSION.PROJECT_UPDATE),
    },
    {
      key: 'access',
      label: '项目访问',
      icon: <ShieldCheck size={14} />,
      visible: hasPermission(permissions, PERMISSION.PROJECT_READ),
    },
    {
      key: 'triggers',
      label: '触发器',
      icon: <Webhook size={14} />,
      visible: hasPermission(permissions, PERMISSION.PROJECT_UPDATE),
    },
    {
      key: 'git',
      label: 'Git 凭据',
      icon: <GitBranch size={14} />,
      visible: hasPermission(permissions, PERMISSION.CREDENTIAL_READ),
    },
    {
      key: 'environments',
      label: '环境',
      icon: <Database size={14} />,
      visible: hasPermission(permissions, PERMISSION.ENVIRONMENT_WRITE),
    },
    {
      key: 'llm',
      label: 'LLM',
      icon: <Sparkles size={14} />,
      visible: hasPermission(permissions, PERMISSION.LLM_WRITE),
    },
    {
      key: 'prompts',
      label: '提示词',
      icon: <FileCog size={14} />,
      visible: hasPermission(permissions, PERMISSION.TENANT_UPDATE),
    },
    {
      key: 'notifications',
      label: '飞书通知',
      icon: <Bell size={14} />,
      visible: hasPermission(permissions, PERMISSION.NOTIFICATION_WRITE),
    },
    {
      key: 'members',
      label: '成员',
      icon: <Users size={14} />,
      visible: hasPermission(permissions, PERMISSION.TENANT_MEMBER_MANAGE),
    },
  ].filter((tab) => tab.visible);
  const activeKey =
    tabs.find((tab) => location.pathname.endsWith(`/settings/${tab.key}`))?.key ??
    tabs[0]?.key ??
    'general';

  if (tabs.length === 0) {
    return <Alert type="info" showIcon message="当前角色没有项目设置权限。" />;
  }

  const base = `/t/${tenantSlug}/p/${project.slug}/settings`;
  const currentTab = tabs.find((tab) => location.pathname.endsWith(`/settings/${tab.key}`));

  // 直接访问当前角色不可见的设置子路由时回到第一个可见 Tab，
  // 避免旧版 /settings/general 在只读角色下仍渲染隐藏内容。
  if (currentTab === undefined) {
    return <Navigate to={`${base}/${tabs[0]?.key ?? 'general'}`} replace />;
  }

  return (
    <div className="space-y-4">
      <Tabs
        activeKey={activeKey}
        onChange={(key) => {
          navigate(`${base}/${key}`);
        }}
        items={tabs.map((tab) => ({
          key: tab.key,
          label: (
            <span className="flex items-center gap-1.5">
              {tab.icon}
              {tab.label}
            </span>
          ),
          children: <Outlet />,
        }))}
      />
    </div>
  );
}
