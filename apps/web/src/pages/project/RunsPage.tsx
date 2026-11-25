// 本文件所有改动要求遵循 agent-rules 规范
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Table,
} from 'antd';
import { PlayCircle, Plus, RefreshCw, Zap } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { PERMISSION } from '@gait/shared';
import type { ModuleTreeNode } from '@gait/shared';
import { api, ApiError } from '../../api/client';
import type { CaseModuleNode, ProjectCommitOption, RunSummary } from '../../api/types';
import ErrorState from '../../components/ErrorState';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import ModulePicker from '../../components/ModulePicker';
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
  selectionType: 'all' | 'modules' | 'impact';
  modules?: string[];
  manualModules?: string;
}

const ACTIVE_STATUSES = ['queued', 'preparing', 'running', 'analyzing', 'reporting'];

/**
 * 用例库模块树（CaseModuleNode：key 为末级段）→ 运行选择用的 ModuleTreeNode（key 为完整层级）。
 * 运行选择时 key 必须是完整 module key，否则后端前缀匹配不到子模块。
 */
function modulesFromCases(nodes: readonly CaseModuleNode[], prefix = ''): ModuleTreeNode[] {
  return nodes.map((node) => {
    const key = prefix.length === 0 ? node.key : `${prefix}.${node.key}`;

    return {
      key,
      name: node.key,
      label: node.label,
      parent: prefix.length === 0 ? null : prefix,
      featurePoints: node.caseCount,
      children: modulesFromCases(node.children, key),
    } as ModuleTreeNode;
  });
}

export default function RunsPage() {
  const { project } = useProject();
  const { tenantSlug } = useParams();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CreateRunFormValues>();
  const [openModal, setOpenModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [commits, setCommits] = useState<ProjectCommitOption[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [latestSha, setLatestSha] = useState<string | null>(null);
  const [modules, setModules] = useState<ModuleTreeNode[]>([]);
  const [modulesLoading, setModulesLoading] = useState(false);
  /** 模块清单来源：cases=用例库已有模块（默认），code=代码扫描结果（用例库无模块时兜底）。 */
  const [modulesSource, setModulesSource] = useState<'cases' | 'code'>('cases');
  const selectionType = Form.useWatch('selectionType', form);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const { data, loading, error, reload } = useAsync(
    () =>
      Promise.all([
        api.listRuns(project.id, { page, pageSize }),
        api.listEnvironments(project.id),
      ]),
    [project.id, page],
  );
  const runs = data?.[0].items ?? [];
  const total = data?.[0].total ?? 0;
  const environments = data?.[1] ?? [];
  const hasActive = runs.some((run) => ACTIVE_STATUSES.includes(run.status));

  usePolling(reload, 5_000, hasActive);

  /** Commit 下拉选项：shortSha + 提交标题 + 相对时间。 */
  const commitOptions = useMemo(
    () =>
      commits.map((commit) => ({
        value: commit.sha,
        label: `${commit.shortSha} · ${commit.title}`,
        title: `${commit.sha}\n${commit.title}\n${commit.author} · ${new Date(commit.committedAt).toLocaleString()}`,
      })),
    [commits],
  );

  /** 打开表单时并行拉取提交历史与模块树。 */
  const openCreate = (): void => {
    setOpenModal(true);
    void loadCommits();
    void loadModules();
  };

  const loadCommits = async (): Promise<void> => {
    setCommitsLoading(true);

    try {
      const result = await api.listProjectCommits(project.id, { limit: 50 });
      setCommits(result.items);
      const latest = result.latestSha ?? result.headSha;
      setLatestSha(latest);

      if (result.warning !== undefined) {
        message.warning(result.warning);
      }
    } catch (cause) {
      // 提交历史是辅助功能，失败不阻断创建（仍可手输 SHA）。
      setCommits([]);
      message.warning(
        cause instanceof ApiError ? cause.message : '无法读取提交历史，可手动输入 SHA',
      );
    } finally {
      setCommitsLoading(false);
    }
  };

  /**
   * 模块清单优先复用用例库已有模块（@module 聚合），保证选中 key 能匹配到真实用例；
   * 用例库还没有模块时才回退到代码扫描结果。
   */
  const loadModules = async (): Promise<void> => {
    setModulesLoading(true);

    try {
      const [caseModules, scanned] = await Promise.all([
        api.listCaseModules(project.id).catch(() => [] as CaseModuleNode[]),
        api.listProjectModules(project.id).catch(() => null),
      ]);
      const fromCases = modulesFromCases(caseModules);

      if (fromCases.length > 0) {
        setModules(fromCases);
        setModulesSource('cases');

        return;
      }

      setModules(scanned?.modules ?? []);
      setModulesSource('code');
    } catch {
      setModules([]);
    } finally {
      setModulesLoading(false);
    }
  };

  /** 触发模块扫描（异步 job）；轮询几次等 Worker 写回结果。 */
  const scanModules = async (): Promise<void> => {
    setModulesLoading(true);

    try {
      await api.scanProjectModules(project.id);

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const result = await api.listProjectModules(project.id);

        if (result.modules.length > 0) {
          setModules(result.modules);
          setModulesSource('code');
          message.success(`已识别 ${result.modules.length} 个顶层模块`);
          return;
        }
      }

      message.info('模块扫描仍在进行，稍后重新打开表单即可看到结果');
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '模块扫描失败');
    } finally {
      setModulesLoading(false);
    }
  };

  /** 快捷填入最新 commit 作为 Head SHA。 */
  const useLatestCommit = (): void => {
    if (latestSha === null) {
      message.info('尚未获取到提交历史');
      return;
    }

    form.setFieldValue('headSha', latestSha);
  };

  const create = async (values: CreateRunFormValues): Promise<void> => {
    setCreating(true);

    try {
      // 模块选择 = 树选中项 + 手补 key，去重后提交。
      const modules = [
        ...(values.modules ?? []),
        ...(values.manualModules ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ].filter((item, index, all) => all.indexOf(item) === index);
      const result = await api.createRun(project.id, {
        headSha: values.headSha,
        environmentId: values.environmentId,
        ...(values.baseSha === undefined ? {} : { baseSha: values.baseSha }),
        ...(values.branch === undefined ? {} : { branch: values.branch }),
        selection: {
          type: values.selectionType,
          ...(values.selectionType === 'modules' ? { modules } : {}),
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
                onClick={() => openCreate()}
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
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: false,
            onChange: (next) => setPage(next),
            hideOnSinglePage: true,
          }}
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
          <Form.Item label="目标 Head SHA" required>
            <Space.Compact className="w-full">
              <Form.Item
                name="headSha"
                noStyle
                rules={[{ required: true, message: '请选择或输入 commit' }]}
              >
                <Select
                  className="w-full"
                  showSearch
                  allowClear
                  loading={commitsLoading}
                  placeholder="从最近提交中选择，或直接粘贴 SHA"
                  options={commitOptions}
                  optionFilterProp="label"
                  notFoundContent={commitsLoading ? '加载中…' : '未获取到提交历史'}
                />
              </Form.Item>
              <Button icon={<Zap size={14} />} onClick={useLatestCommit} title="填入最新 commit">
                最新
              </Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item name="baseSha" label="Base SHA（可选）">
            <Select
              showSearch
              allowClear
              loading={commitsLoading}
              placeholder="用于报告中的变更范围，可留空"
              options={commitOptions}
              optionFilterProp="label"
              notFoundContent={commitsLoading ? '加载中…' : '未获取到提交历史'}
            />
          </Form.Item>
          <Form.Item name="branch" label="分支（可选）">
            <Input placeholder={project.defaultBranch} />
          </Form.Item>
          <Form.Item name="selectionType" label="用例选择">
            <Radio.Group
              options={[
                { value: 'all', label: '全部' },
                { value: 'impact', label: '影响面（base..head）' },
                { value: 'modules', label: '按模块' },
              ]}
            />
          </Form.Item>
          {selectionType === 'impact' && (
            <p className="text-xs text-gh-muted">
              按 base..head 变更路径推断模块并只运行匹配 @module 的场景；未填写 Base SHA
              时退化为全部。
            </p>
          )}
          {selectionType === 'modules' && (
            <>
              <Form.Item
                name="modules"
                label="模块目录树"
                tooltip="选中父模块即命中整棵子树；不选则为全部模块"
                rules={[{ required: true, message: '请至少选择一个模块' }]}
              >
                <ModulePicker
                  modules={modules}
                  loading={modulesLoading}
                  compact
                  source={modulesSource}
                  onScan={() => {
                    void scanModules();
                  }}
                />
              </Form.Item>
              <Form.Item
                name="manualModules"
                label="手动补充模块 key（逗号分隔，可选）"
                tooltip="用于模块清单里没有的模块；与上方选择合并"
              >
                <Input placeholder="posts.comments, auth" />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}
