// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import { App as AntdApp, Button, Card, Form, Input, Modal, Radio, Select, Table } from 'antd';
import { PlayCircle, Plus, RefreshCw } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { PERMISSION } from '@gait/shared';
import { api, ApiError } from '../../api/client';
import type { RunSummary } from '../../api/types';
import ErrorState from '../../components/ErrorState';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import PageHeader from '../../components/PageHeader';
import PermissionGate from '../../components/PermissionGate';
import StatusBadge from '../../components/StatusBadge';
import { useProject } from '../../components/ProjectLayout';
import { useAsync } from '../../hooks/useAsync';
import { usePolling } from '../../hooks/usePolling';

interface CreateRunFormValues {
  environmentId: string;
  baseSha?: string;
  headSha: string;
  branch?: string;
  selectionType: 'all' | 'modules' | 'cases';
  modules?: string;
  caseKeys?: string;
}

const ACTIVE_STATUSES = ['queued', 'preparing', 'running', 'analyzing', 'reporting'];

export default function RunsPage() {
  const { project } = useProject();
  const { tenantSlug } = useParams();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CreateRunFormValues>();
  const [openModal, setOpenModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const selectionType = Form.useWatch('selectionType', form);
  const { data, loading, error, reload } = useAsync(
    () => Promise.all([api.listRuns(project.id), api.listEnvironments(project.id)]),
    [project.id],
  );
  const runs = data?.[0] ?? [];
  const environments = data?.[1] ?? [];
  const hasActive = runs.some((run) => ACTIVE_STATUSES.includes(run.status));

  usePolling(reload, 5_000, hasActive);

  const create = async (values: CreateRunFormValues): Promise<void> => {
    setCreating(true);

    try {
      const modules = (values.modules ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const caseKeys = (values.caseKeys ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const result = await api.createRun(project.id, {
        headSha: values.headSha,
        environmentId: values.environmentId,
        ...(values.baseSha === undefined ? {} : { baseSha: values.baseSha }),
        ...(values.branch === undefined ? {} : { branch: values.branch }),
        selection: {
          type: values.selectionType,
          ...(values.selectionType === 'modules' ? { modules } : {}),
          ...(values.selectionType === 'cases' ? { caseKeys } : {}),
        },
      });

      message.success(result.created ? '运行已创建' : '已存在相同运行');
      setOpenModal(false);
      form.resetFields();
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '创建运行失败');
    } finally {
      setCreating(false);
    }
  };

  const canCreate = environments.length > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="测试运行"
        description="对已部署环境执行 Suite 场景；平台不会构建或部署产品代码"
        actions={
          <>
            <Button icon={<RefreshCw size={15} />} onClick={reload}>
              刷新
            </Button>
            <PermissionGate permission={PERMISSION.RUN_CREATE}>
              <Button
                type="primary"
                icon={<Plus size={15} />}
                disabled={!canCreate}
                title={canCreate ? undefined : '请先配置测试环境'}
                onClick={() => setOpenModal(true)}
              >
                创建运行
              </Button>
            </PermissionGate>
          </>
        }
      />

      {loading && data === undefined && <LoadingSkeleton />}
      {error !== undefined && <ErrorState error={error} onRetry={reload} />}

      {data !== undefined && environments.length === 0 && (
        <Card>
          <p className="text-sm text-gh-muted">
            尚未配置测试环境。请先到{' '}
            <Link to={`/t/${tenantSlug}/p/${project.slug}/settings/environments`}>设置 → 环境</Link>{' '}
            创建至少一个环境。
          </p>
        </Card>
      )}

      <Card styles={{ body: { padding: 0 } }}>
        <Table<RunSummary>
          rowKey="id"
          size="small"
          loading={loading && data === undefined}
          dataSource={runs}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: '暂无运行' }}
          columns={[
            {
              title: 'Run',
              dataIndex: 'id',
              render: (id: string, run) => (
                <div>
                  <Link
                    to={`/t/${tenantSlug}/p/${project.slug}/runs/${id}`}
                    className="font-mono text-xs text-gh-blue"
                  >
                    {id.slice(0, 14)}…
                  </Link>
                  <div className="mt-1 flex items-center gap-2">
                    <StatusBadge status={run.status} />
                    {run.stats.flaky !== undefined && run.stats.flaky > 0 && (
                      <span className="text-xs text-[#8250df]">flaky {run.stats.flaky}</span>
                    )}
                  </div>
                </div>
              ),
            },
            {
              title: '目标 commit',
              dataIndex: 'headSha',
              render: (sha: string, run) => (
                <div className="text-xs">
                  <code className="font-mono">{sha.slice(0, 8)}</code>
                  {run.versionMatch === false && (
                    <div className="text-gh-warning">部署版本不一致</div>
                  )}
                </div>
              ),
            },
            {
              title: '分支 / 触发',
              dataIndex: 'branch',
              render: (branch: string | null, run) => (
                <div className="text-xs">
                  <div>{branch ?? '-'}</div>
                  <div className="text-gh-muted">{run.trigger}</div>
                </div>
              ),
            },
            {
              title: '通过率',
              dataIndex: 'stats',
              render: (stats: RunSummary['stats']) => {
                const total = stats.total ?? 0;

                return total === 0 ? (
                  <span className="text-xs text-gh-muted">-</span>
                ) : (
                  <div className="text-xs">
                    <div>
                      {Math.round(((stats.passed ?? 0) / total) * 100)}%（{stats.passed ?? 0}/
                      {total}）
                    </div>
                    <div className="text-gh-muted">
                      失败 {(stats.failed ?? 0) + (stats.error ?? 0)} · 环境{' '}
                      {stats.classifications?.env_issue ?? 0}
                    </div>
                  </div>
                );
              },
            },
            {
              title: '耗时',
              dataIndex: 'stats',
              render: (stats: RunSummary['stats']) =>
                stats.durationMs === undefined ? '-' : `${Math.round(stats.durationMs / 1000)}s`,
            },
            {
              title: '创建时间',
              dataIndex: 'createdAt',
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
            {
              title: '',
              width: 70,
              render: (_value, run) => (
                <Link to={`/t/${tenantSlug}/p/${project.slug}/runs/${run.id}`}>
                  <Button size="small" icon={<PlayCircle size={13} />}>
                    详情
                  </Button>
                </Link>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={openModal}
        title="创建运行"
        okText="创建"
        cancelText="取消"
        confirmLoading={creating}
        onCancel={() => setOpenModal(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<CreateRunFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ selectionType: 'all' }}
          onFinish={(values) => {
            void create(values);
          }}
        >
          <Form.Item name="environmentId" label="环境" rules={[{ required: true }]}>
            <Select
              options={environments.map((environment) => ({
                value: environment.id,
                label: `${environment.name}${environment.isDefault ? '（默认）' : ''}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="headSha"
            label="目标 Head SHA"
            rules={[
              { required: true },
              { pattern: /^[0-9a-f]{7,64}$/i, message: '请输入 Git commit SHA' },
            ]}
          >
            <Input placeholder="4f2c1a9..." className="font-mono" />
          </Form.Item>
          <Form.Item name="baseSha" label="Base SHA（可选）">
            <Input placeholder="用于报告中的变更范围" className="font-mono" />
          </Form.Item>
          <Form.Item name="branch" label="分支（可选）">
            <Input placeholder={project.defaultBranch} />
          </Form.Item>
          <Form.Item name="selectionType" label="用例选择">
            <Radio.Group
              options={[
                { value: 'all', label: '全部' },
                { value: 'modules', label: '按模块' },
                { value: 'cases', label: '按 caseKey' },
              ]}
            />
          </Form.Item>
          {selectionType === 'modules' && (
            <Form.Item name="modules" label="模块（逗号分隔）" rules={[{ required: true }]}>
              <Input placeholder="auth, posts" />
            </Form.Item>
          )}
          {selectionType === 'cases' && (
            <Form.Item name="caseKeys" label="Case Key（逗号分隔）" rules={[{ required: true }]}>
              <Input placeholder="RUN-API-001, RUN-DB-001" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
