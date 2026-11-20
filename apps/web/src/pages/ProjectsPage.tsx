// 本文件所有改动要求遵循 agent-rules 规范
import { Button, Card, Empty } from 'antd';
import { FolderGit2, Plus } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';

export default function ProjectsPage() {
  const { state } = useAuth();

  if (state.status !== 'authenticated') {
    return null;
  }

  const { activeTenant, user } = state.session;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gh-text">{activeTenant.name}</h2>
          <p className="mt-1 text-sm text-gh-muted">
            当前用户 @{user.username} · 租户 <code className="font-mono">{activeTenant.slug}</code>
          </p>
        </div>
        <Button type="primary" icon={<Plus size={16} />} disabled title="项目功能将在 M3 提供">
          新建项目
        </Button>
      </div>

      <Card>
        <Empty
          image={
            <div className="flex justify-center text-gh-muted">
              <FolderGit2 size={44} strokeWidth={1.5} />
            </div>
          }
          description={
            <div className="space-y-1">
              <p className="text-sm font-medium text-gh-text">还没有项目</p>
              <p className="text-sm text-gh-muted">
                项目创建、Git 凭据与测试环境配置将在 M3 里程碑提供。
              </p>
            </div>
          }
        />
      </Card>
    </div>
  );
}
