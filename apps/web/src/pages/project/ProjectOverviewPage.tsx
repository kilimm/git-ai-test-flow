// 本文件所有改动要求遵循 agent-rules 规范
import { Button, Card, Col, Row, Statistic, Table, Tag } from 'antd';
import { GitPullRequest, PlayCircle, ServerCog } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { RunSummary } from '../../api/types';
import ErrorState from '../../components/ErrorState';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import PageHeader from '../../components/PageHeader';
import StatusBadge from '../../components/StatusBadge';
import { useProject } from '../../components/ProjectLayout';
import { useAsync } from '../../hooks/useAsync';

export default function ProjectOverviewPage() {
  const { project } = useProject();
  const { tenantSlug } = useParams();
  const { data, loading, error, reload } = useAsync(
    () =>
      Promise.all([
        api.listRuns(project.id),
        api.listEnvironments(project.id),
        api.listGenerations(project.id),
        api.listCases(project.id),
      ]),
    [project.id],
  );

  if (loading && data === undefined) {
    return <LoadingSkeleton rows={8} />;
  }

  if (error !== undefined) {
    return <ErrorState error={error} onRetry={reload} />;
  }

  const [runs, environments, generations, cases] = data ?? [[], [], [], []];
  const succeeded = runs.filter((run) => run.status === 'succeeded').length;
  const running = runs.filter((run) =>
    ['queued', 'preparing', 'running', 'analyzing', 'reporting'].includes(run.status),
  ).length;
  const waiting = generations.filter(
    (generation) => generation.status === 'awaiting_approval',
  ).length;
  const base = `/t/${tenantSlug}/p/${project.slug}`;

  const columns = [
    {
      title: 'Run',
      dataIndex: 'id',
      render: (id: string) => (
        <Link to={`${base}/runs/${id}`} className="font-mono text-xs text-gh-blue">
          {id.slice(0, 12)}…
        </Link>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (status: string) => <StatusBadge status={status} />,
    },
    {
      title: 'Commit',
      dataIndex: 'headSha',
      render: (sha: string) => <code className="font-mono text-xs">{sha.slice(0, 8)}</code>,
    },
    {
      title: '通过率',
      dataIndex: 'stats',
      render: (stats: RunSummary['stats']) => {
        const total = stats.total ?? 0;

        return total === 0
          ? '-'
          : `${Math.round(((stats.passed ?? 0) / total) * 100)}%（${stats.passed ?? 0}/${total}）`;
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="项目概览"
        description="仓库、用例与最近运行状态"
        actions={
          <>
            <Link to={`${base}/changes`}>
              <Button icon={<GitPullRequest size={15} />}>生成用例</Button>
            </Link>
            <Link to={`${base}/runs`}>
              <Button type="primary" icon={<PlayCircle size={15} />}>
                创建运行
              </Button>
            </Link>
          </>
        }
      />

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="最近运行" value={runs.length} suffix={`/ ${succeeded} 成功`} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="执行中"
              value={running}
              {...(running > 0 ? { valueStyle: { color: '#0969da' } } : {})}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="索引用例" value={cases.length} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="待审批生成"
              value={waiting}
              {...(waiting > 0 ? { valueStyle: { color: '#9a6700' } } : {})}
            />
          </Card>
        </Col>
      </Row>

      <Card title="仓库与套件" extra={<ServerCog size={16} className="text-gh-muted" />}>
        <dl className="grid gap-3 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-gh-muted">产品仓库</dt>
            <dd className="mt-0.5 break-all font-mono text-xs">{project.productRepoUrl}</dd>
          </div>
          <div>
            <dt className="text-xs text-gh-muted">默认分支</dt>
            <dd className="mt-0.5 font-mono text-xs">{project.defaultBranch}</dd>
          </div>
          <div>
            <dt className="text-xs text-gh-muted">Suite 模式</dt>
            <dd className="mt-0.5">
              <Tag>{project.suiteMode}</Tag>
              {project.suiteRepoUrl !== null && (
                <code className="font-mono text-xs">{project.suiteRepoUrl}</code>
              )}
              {project.suitePath !== null && (
                <code className="font-mono text-xs">{project.suitePath}</code>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gh-muted">环境</dt>
            <dd className="mt-0.5">
              {environments.length === 0
                ? '未配置'
                : environments.map((environment) => (
                    <Tag
                      key={environment.id}
                      color={environment.healthStatus === 'healthy' ? 'green' : 'default'}
                    >
                      {environment.name}
                    </Tag>
                  ))}
            </dd>
          </div>
        </dl>
      </Card>

      <Card
        title="最近运行"
        extra={<Link to={`${base}/runs`}>查看全部</Link>}
        styles={{ body: { padding: 0 } }}
      >
        <Table<RunSummary>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={runs.slice(0, 5)}
          pagination={false}
          locale={{ emptyText: '暂无运行' }}
        />
      </Card>
    </div>
  );
}
