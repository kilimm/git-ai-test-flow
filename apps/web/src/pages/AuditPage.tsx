// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import { Alert, Card, Drawer, Input, Select, Table, Tag } from 'antd';
import { RefreshCw, Search } from 'lucide-react';
import { PERMISSION } from '@gait/shared';
import { Button } from 'antd';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../api/client';
import type { AuditEntry } from '../api/types';
import ErrorState from '../components/ErrorState';
import LoadingSkeleton from '../components/LoadingSkeleton';
import PageHeader from '../components/PageHeader';
import { usePermission } from '../components/PermissionGate';
import { useAsync } from '../hooks/useAsync';

function parseDetail(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return value;
  }
}

export default function AuditPage() {
  const { state } = useAuth();
  const allowed = usePermission(PERMISSION.AUDIT_READ);
  const [action, setAction] = useState<string | undefined>(undefined);
  const [resourceType, setResourceType] = useState<string | undefined>(undefined);
  const [keyword, setKeyword] = useState('');
  const [currentData, setCurrentData] = useState<AuditEntry | null>(null);
  const { data, loading, error, reload } = useAsync(
    () =>
      allowed
        ? api.listAudit({
            limit: 100,
            ...(action === undefined ? {} : { action }),
            ...(resourceType === undefined ? {} : { resourceType }),
          })
        : Promise.resolve({ items: [], nextCursor: null }),
    [action, resourceType, allowed],
  );

  if (state.status !== 'authenticated') {
    return null;
  }

  if (!allowed) {
    return <Alert type="warning" showIcon message="当前角色没有审计日志权限。" />;
  }

  const entries = (data?.items ?? []).filter((entry) => {
    const value = keyword.trim().toLowerCase();

    return (
      value.length === 0 ||
      entry.action.toLowerCase().includes(value) ||
      (entry.actorUsername ?? '').toLowerCase().includes(value) ||
      (entry.resourceId ?? '').toLowerCase().includes(value) ||
      (entry.resourceType ?? '').toLowerCase().includes(value)
    );
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="审计日志"
        description={`租户 ${state.session.activeTenant.name} 的安全与配置变更记录`}
        actions={
          <Button icon={<RefreshCw size={15} />} onClick={reload}>
            刷新
          </Button>
        }
      />

      <Card
        styles={{ body: { padding: 0 } }}
        title={
          <div className="flex flex-wrap gap-2">
            <Input
              allowClear
              size="small"
              prefix={<Search size={13} />}
              placeholder="用户 / 资源 / 动作"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              className="w-56"
            />
            <Input
              allowClear
              size="small"
              placeholder="动作精确过滤（如 run.create）"
              value={action}
              onChange={(event) =>
                setAction(event.target.value.length === 0 ? undefined : event.target.value)
              }
              className="w-56"
            />
            <Select
              allowClear
              size="small"
              placeholder="资源类型"
              className="w-44"
              value={resourceType}
              onChange={setResourceType}
              options={[
                'project',
                'credential',
                'environment',
                'llm_profile',
                'notification_channel',
                'generation',
                'run',
                'run_case',
                'tenant',
                'tenant_member',
              ].map((value) => ({ value, label: value }))}
            />
          </div>
        }
      >
        {loading && data === undefined ? (
          <div className="p-4">
            <LoadingSkeleton />
          </div>
        ) : error !== undefined ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={reload} />
          </div>
        ) : (
          <Table<AuditEntry>
            rowKey="id"
            size="small"
            dataSource={entries}
            pagination={{ pageSize: 30, hideOnSinglePage: true }}
            onRow={(record) => ({
              onClick: () => setCurrentData(record),
              className: 'cursor-pointer',
            })}
            columns={[
              {
                title: '时间',
                dataIndex: 'createdAt',
                render: (value: string) => new Date(value).toLocaleString('zh-CN'),
              },
              {
                title: '用户',
                dataIndex: 'actorUsername',
                render: (value: string | null) => value ?? 'system',
              },
              {
                title: '动作',
                dataIndex: 'action',
                render: (value: string) => <code className="text-xs">{value}</code>,
              },
              {
                title: '资源',
                dataIndex: 'resourceType',
                render: (value: string | null, entry) => (
                  <div>
                    <Tag>{value ?? '-'}</Tag>
                    <code className="text-xs">{entry.resourceId?.slice(0, 12) ?? ''}</code>
                  </div>
                ),
              },
              { title: 'IP', dataIndex: 'ip', render: (value: string | null) => value ?? '-' },
            ]}
          />
        )}
      </Card>

      <Drawer
        open={currentData !== null}
        onClose={() => setCurrentData(null)}
        title="审计详情"
        width={620}
      >
        {currentData !== null && (
          <>
            <div className="mb-3 space-y-1 text-sm">
              <div>
                <span className="text-gh-muted">动作：</span>
                <code>{currentData.action}</code>
              </div>
              <div>
                <span className="text-gh-muted">用户：</span>
                {currentData.actorUsername ?? 'system'}
              </div>
              <div>
                <span className="text-gh-muted">时间：</span>
                {new Date(currentData.createdAt).toISOString()}
              </div>
              <div>
                <span className="text-gh-muted">IP：</span>
                {currentData.ip ?? '-'}
              </div>
            </div>
            <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-all rounded bg-gh-canvas p-3 font-mono text-xs">
              {parseDetail(currentData.detailJson)}
            </pre>
          </>
        )}
      </Drawer>
    </div>
  );
}
