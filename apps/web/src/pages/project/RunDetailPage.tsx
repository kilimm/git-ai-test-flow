// 本文件所有改动要求遵循 agent-rules 规范
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  Popconfirm,
  Row,
  Select,
  Statistic,
  Table,
  Tag,
} from 'antd';
import { ArrowLeft, CircleStop, Download, FileText, RefreshCw, Search } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { PERMISSION } from '@gait/shared';
import { api, ApiError } from '../../api/client';
import type { RunCase } from '../../api/types';
import ClassificationBadge from '../../components/ClassificationBadge';
import ErrorState from '../../components/ErrorState';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import PageHeader from '../../components/PageHeader';
import PermissionGate from '../../components/PermissionGate';
import StatusBadge from '../../components/StatusBadge';
import { useProject } from '../../components/ProjectLayout';
import { useAsync } from '../../hooks/useAsync';
import { useEventStream } from '../../hooks/useEventStream';
import { usePolling } from '../../hooks/usePolling';

const ACTIVE_STATUSES = ['queued', 'preparing', 'running', 'analyzing', 'reporting'];

export default function RunDetailPage() {
  const { project } = useProject();
  const { runId, tenantSlug } = useParams();
  const { message } = AntdApp.useApp();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [classificationFilter, setClassificationFilter] = useState<string | undefined>(undefined);
  const [canceling, setCanceling] = useState(false);
  const { data, loading, error, reload } = useAsync(
    () => Promise.all([api.getRun(runId ?? ''), api.listEnvironments(project.id)]),
    [runId, project.id],
  );
  const run = data?.[0];
  const environments = data?.[1] ?? [];
  const active = run !== undefined && ACTIVE_STATUSES.includes(run.status);

  usePolling(reload, 3_000, active);
  useEventStream(runId === undefined ? undefined : api.runEventsUrl(runId), reload, active);

  const cases = useMemo(() => {
    const keyword = search.trim().toLowerCase();

    return (run?.cases ?? []).filter((runCase) => {
      if (statusFilter !== undefined && runCase.status !== statusFilter) {
        return false;
      }

      if (
        classificationFilter !== undefined &&
        (runCase.classification ?? 'none') !== classificationFilter
      ) {
        return false;
      }

      return (
        keyword.length === 0 ||
        runCase.scenarioName.toLowerCase().includes(keyword) ||
        (runCase.caseKey ?? '').toLowerCase().includes(keyword) ||
        runCase.featurePath.toLowerCase().includes(keyword)
      );
    });
  }, [run, search, statusFilter, classificationFilter]);

  if (loading && run === undefined) {
    return <LoadingSkeleton rows={10} />;
  }

  if (error !== undefined) {
    return <ErrorState error={error} onRetry={reload} />;
  }

  if (run === undefined) {
    return <Alert type="error" showIcon message="运行不存在或无权访问" />;
  }

  const environment = environments.find((item) => item.id === run.environmentId);
  const baselineEnvironment = environments.find((item) => item.id === run.baselineEnvironmentId);
  const total = run.stats.total ?? 0;
  const passed = run.stats.passed ?? 0;
  const failed = (run.stats.failed ?? 0) + (run.stats.error ?? 0);
  const base = `/t/${tenantSlug}/p/${project.slug}`;
  const report = `/api/v1/runs/${run.id}/report`;

  const cancel = async (): Promise<void> => {
    setCanceling(true);

    try {
      await api.cancelRun(run.id);
      message.success('已请求取消');
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '取消失败');
    } finally {
      setCanceling(false);
    }
  };

  const columns = [
    {
      title: '结果',
      dataIndex: 'status',
      render: (status: string) => <StatusBadge status={status} />,
    },
    {
      title: '场景',
      dataIndex: 'scenarioName',
      render: (name: string, runCase: RunCase) => (
        <div>
          <Link
            to={`${base}/runs/${run.id}/cases/${runCase.id}`}
            className="text-sm font-medium text-gh-blue"
          >
            {name}
          </Link>
          <div className="text-xs text-gh-muted">
            <code>
              {runCase.featurePath}:{runCase.line}
            </code>
            {runCase.caseKey !== null && <span> · {runCase.caseKey}</span>}
          </div>
        </div>
      ),
    },
    {
      title: '分类',
      dataIndex: 'classification',
      render: (classification: RunCase['classification'], runCase: RunCase) => (
        <div className="flex items-center gap-1">
          <ClassificationBadge classification={classification} confidence={runCase.confidence} />
          {runCase.evidence.rerun?.passed === true && <Tag color="purple">重跑通过</Tag>}
        </div>
      ),
    },
    {
      title: '尝试',
      dataIndex: 'attempt',
      render: (attempt: number) => <span className="text-xs">{attempt}</span>,
    },
    {
      title: '修复',
      dataIndex: 'repairStatus',
      render: (value: string | null, runCase: RunCase) =>
        value === null && runCase.repairs.length === 0 ? (
          <span className="text-xs text-gh-muted">-</span>
        ) : (
          <div className="flex flex-col gap-1">
            <Tag color={value === 'verified' ? 'green' : value === 'failed' ? 'red' : 'gold'}>
              {value ?? 'repair'}
            </Tag>
            {runCase.repairs.length > 0 && (
              <span className="text-[11px] text-gh-muted">{runCase.repairs.length} 次</span>
            )}
          </div>
        ),
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      render: (value: number | null) => (value === null ? '-' : `${(value / 1000).toFixed(1)}s`),
    },
    {
      title: '错误',
      dataIndex: 'errorMessage',
      render: (value: string | null) =>
        value === null ? (
          '-'
        ) : (
          <span className="line-clamp-2 max-w-[320px] text-xs text-gh-danger" title={value}>
            {value}
          </span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={
          <Link to={`${base}/runs`} className="inline-flex items-center gap-1">
            <ArrowLeft size={13} /> 返回运行列表
          </Link>
        }
        title={`Run ${run.id.slice(0, 14)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <code className="font-mono text-xs">{run.headSha}</code>
            {run.versionMatch === false && <Tag color="gold">部署版本不一致</Tag>}
          </span>
        }
        actions={
          <>
            <Button icon={<RefreshCw size={15} />} onClick={reload}>
              刷新
            </Button>
            <Button icon={<FileText size={15} />} href={`${report}?format=markdown&download=1`}>
              导出 Markdown
            </Button>
            <PermissionGate permission={PERMISSION.RUN_CANCEL}>
              <Popconfirm
                title="取消运行"
                description="正在执行的 HTTP/浏览器/脚本会在下一个检查点停止。"
                okText="取消运行"
                okButtonProps={{ danger: true }}
                cancelText="返回"
                disabled={!active}
                onConfirm={() => void cancel()}
              >
                <Button
                  danger
                  icon={<CircleStop size={15} />}
                  loading={canceling}
                  disabled={!active}
                >
                  取消运行
                </Button>
              </Popconfirm>
            </PermissionGate>
          </>
        }
      />

      {active && (
        <Alert
          type="info"
          showIcon
          message="运行进行中：SSE 实时刷新事件，同时保留 3 秒轮询兜底。"
        />
      )}
      {run.error !== null && (
        <Alert
          type="error"
          showIcon
          message="运行错误"
          description={<code className="text-xs">{JSON.stringify(run.error)}</code>}
        />
      )}

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="通过率"
              value={total === 0 ? 0 : Math.round((passed / total) * 100)}
              suffix="%"
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="用例" value={total} suffix={`/ ${passed} 通过`} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="失败"
              value={failed}
              {...(failed > 0 ? { valueStyle: { color: '#cf222e' } } : {})}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="flaky / 隔离"
              value={`${run.stats.flaky ?? 0} / ${run.stats.quarantined ?? 0}`}
            />
          </Card>
        </Col>
      </Row>

      <Card>
        <Descriptions
          size="small"
          column={{ xs: 1, md: 3 }}
          items={[
            {
              key: 'env',
              label: '环境',
              children: environment?.name ?? run.environmentId ?? '未配置',
            },
            {
              key: 'deployed',
              label: '部署版本',
              children: <code className="font-mono text-xs">{run.deployedSha ?? '未知'}</code>,
            },
            {
              key: 'baseline',
              label: '基线环境',
              children:
                run.baselineEnvironmentId === null
                  ? '未配置'
                  : (baselineEnvironment?.name ?? run.baselineEnvironmentId),
            },
            { key: 'branch', label: '分支', children: run.branch ?? '-' },
            {
              key: 'selection',
              label: '用例选择',
              children: `${run.selection.type}${
                run.selection.modules.length > 0 ? `: ${run.selection.modules.join(', ')}` : ''
              }`,
            },
            {
              key: 'namespace',
              label: '命名空间',
              children: <code className="font-mono text-xs">{run.namespace}</code>,
            },
            {
              key: 'analysis',
              label: '归因',
              children:
                run.stats.analysis === undefined
                  ? '-'
                  : `规则 ${run.stats.analysis.rule ?? 0} · LLM ${
                      run.stats.analysis.llm ?? 0
                    } · token ${run.stats.analysis.llmInputTokens ?? 0}/${
                      run.stats.analysis.llmOutputTokens ?? 0
                    }`,
            },
            {
              key: 'duration',
              label: '耗时',
              children:
                run.stats.durationMs === undefined
                  ? '-'
                  : `${(run.stats.durationMs / 1000).toFixed(1)}s`,
            },
          ]}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {(['json', 'markdown', 'html', 'junit'] as const).map((format) => (
            <Button
              key={format}
              size="small"
              icon={<Download size={13} />}
              href={`${report}?format=${format}&download=1`}
            >
              {format.toUpperCase()}
            </Button>
          ))}
        </div>
      </Card>

      <Card
        title="用例"
        extra={
          <div className="flex flex-wrap gap-2">
            <Input
              allowClear
              size="small"
              prefix={<Search size={13} />}
              placeholder="场景 / caseKey / 文件"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-52"
            />
            <Select
              allowClear
              size="small"
              placeholder="状态"
              className="w-28"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                'pending',
                'running',
                'passed',
                'failed',
                'error',
                'skipped',
                'quarantined',
              ].map((value) => ({ value, label: value }))}
            />
            <Select
              allowClear
              size="small"
              placeholder="分类"
              className="w-32"
              value={classificationFilter}
              onChange={setClassificationFilter}
              options={[
                { value: 'none', label: '未归因' },
                { value: 'code_bug', label: '代码缺陷' },
                { value: 'test_bug', label: '用例问题' },
                { value: 'env_issue', label: '环境问题' },
                { value: 'flaky', label: '偶发失败' },
                { value: 'unknown', label: '待确认' },
              ]}
            />
          </div>
        }
        styles={{ body: { padding: 0 } }}
      >
        <Table<RunCase>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={cases}
          pagination={{ pageSize: 30, hideOnSinglePage: true }}
          locale={{ emptyText: '没有匹配的用例' }}
        />
      </Card>
    </div>
  );
}
