// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Collapse,
  Descriptions,
  Popconfirm,
  Space,
  Table,
  Tag,
} from 'antd';
import { ArrowLeft, FileText } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { PERMISSION } from '@gait/shared';
import { api, ApiError } from '../../api/client';
import type { EvidenceStep } from '../../api/types';
import ArtifactPreview from '../../components/ArtifactPreview';
import ClassificationBadge from '../../components/ClassificationBadge';
import ErrorState from '../../components/ErrorState';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import PageHeader from '../../components/PageHeader';
import PermissionGate from '../../components/PermissionGate';
import StatusBadge from '../../components/StatusBadge';
import StepTimeline from '../../components/StepTimeline';
import { useProject } from '../../components/ProjectLayout';
import { useAsync } from '../../hooks/useAsync';
import { useEventStream } from '../../hooks/useEventStream';
import { usePolling } from '../../hooks/usePolling';

function stepFromPack(step: EvidenceStep) {
  return {
    id: `evidence-${step.index}`,
    index: step.index,
    keyword: step.keyword,
    text: step.text,
    type: step.type,
    status: step.status,
    durationMs: step.durationMs,
    output:
      typeof step.output === 'object' && step.output !== null
        ? (step.output as Record<string, unknown>)
        : {},
    error: step.error,
    artifacts: [],
  };
}

export default function RunCasePage() {
  const { project } = useProject();
  const { runId, caseId, tenantSlug } = useParams();
  const { message } = AntdApp.useApp();
  const [repairing, setRepairing] = useState(false);
  const { data, loading, error, reload } = useAsync(() => api.getRun(runId ?? ''), [runId]);
  const runCase = data?.cases.find((item) => item.id === caseId);
  const activeCase = runCase?.status === 'running' || runCase?.status === 'pending';

  usePolling(reload, 3_000, activeCase);
  useEventStream(runId === undefined ? undefined : api.runEventsUrl(runId), reload, activeCase);

  const repairAction = async (
    kind: 'approve' | 'reject' | 'rollback',
    repairId: string,
  ): Promise<void> => {
    if (runCase === undefined) {
      return;
    }

    setRepairing(true);

    try {
      await (kind === 'approve'
        ? api.approveRepair(runCase.id, repairId)
        : kind === 'reject'
          ? api.rejectRepair(runCase.id, repairId)
          : api.rollbackRepair(runCase.id, repairId));
      message.success(
        kind === 'approve' ? '修复已提交到 Suite' : kind === 'reject' ? '修复已拒绝' : '修复已回滚',
      );
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '修复操作失败');
    } finally {
      setRepairing(false);
    }
  };

  if (loading && data === undefined) {
    return <LoadingSkeleton rows={10} />;
  }

  if (error !== undefined) {
    return <ErrorState error={error} onRetry={reload} />;
  }

  if (data === undefined || runCase === undefined) {
    return <Alert type="error" showIcon message="用例不存在或已不在该运行中" />;
  }

  const base = `/t/${tenantSlug}/p/${project.slug}`;
  const attribution = runCase.evidence.attribution;
  const evidence = runCase.evidence.evidence;
  const steps = evidence !== undefined ? evidence.steps.map(stepFromPack) : runCase.steps;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={
          <Link to={`${base}/runs/${data.id}`} className="inline-flex items-center gap-1">
            <ArrowLeft size={13} /> 返回运行
          </Link>
        }
        title={runCase.scenarioName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={runCase.status} />
            <ClassificationBadge
              classification={runCase.classification}
              confidence={runCase.confidence}
            />
            <code className="text-xs">
              {runCase.featurePath}:{runCase.line}
            </code>
            {runCase.evidence.rerun?.passed === true && <Tag color="purple">重跑通过</Tag>}
            {runCase.evidence.rerun?.attempted === true &&
              runCase.evidence.rerun.passed === false && <Tag>重跑仍失败</Tag>}
          </span>
        }
        actions={
          <Button
            icon={<FileText size={15} />}
            href={`/api/v1/runs/${data.id}/report?format=markdown&download=1`}
          >
            导出运行报告
          </Button>
        }
      />

      {runCase.status === 'passed' && runCase.classification === 'flaky' && (
        <Alert
          type="warning"
          showIcon
          message="偶发失败"
          description="该用例首次执行失败、重跑通过，已标记 flaky，不会生成修复建议。"
        />
      )}
      {runCase.errorMessage !== null && (
        <Alert
          type="error"
          showIcon
          message="错误信息"
          description={<code className="whitespace-pre-wrap text-xs">{runCase.errorMessage}</code>}
        />
      )}

      <Card title="用例信息">
        <Descriptions
          size="small"
          column={{ xs: 1, md: 2 }}
          items={[
            { key: 'caseKey', label: 'Case Key', children: runCase.caseKey ?? '-' },
            { key: 'layer', label: 'Layer', children: runCase.layer ?? '-' },
            { key: 'attempt', label: '尝试次数', children: runCase.attempt },
            {
              key: 'duration',
              label: '耗时',
              children:
                runCase.durationMs === null ? '-' : `${(runCase.durationMs / 1000).toFixed(1)}s`,
            },
            {
              key: 'tags',
              label: 'Tags',
              children: runCase.tags.map((tag) => <Tag key={tag}>{tag}</Tag>),
            },
            {
              key: 'errorCode',
              label: '错误码',
              children: <code className="text-xs">{runCase.evidence.errorCode ?? '-'}</code>,
            },
          ]}
        />
        {runCase.artifacts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-3">
            {runCase.artifacts.map((artifact) => (
              <ArtifactPreview key={artifact.id} runId={data.id} artifact={artifact} />
            ))}
          </div>
        )}
      </Card>

      <Card title="归因">
        {attribution === undefined ? (
          <p className="text-sm text-gh-muted">该用例尚未归因（可能通过、取消或归因阶段失败）。</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <ClassificationBadge
                classification={attribution.verdict}
                confidence={Math.round(attribution.confidence * 100)}
              />
              <Tag>{attribution.source}</Tag>
              {attribution.conflict !== null && (
                <Tag color="orange">
                  与 {attribution.conflict.otherVerdict} 冲突（
                  {Math.round(attribution.conflict.otherConfidence * 100)}%）
                </Tag>
              )}
              {attribution.testRepairAllowed ? (
                <Tag color="green">允许生成用例修复建议</Tag>
              ) : (
                <Tag>禁止自动改测试</Tag>
              )}
            </div>
            <div>
              <div className="text-xs text-gh-muted">根因</div>
              <p className="mt-1 text-sm text-gh-text">{attribution.rootCause}</p>
            </div>
            {attribution.suggestedFix !== null && (
              <div>
                <div className="text-xs text-gh-muted">修复建议（P0 仅建议，需人工确认）</div>
                <p className="mt-1 rounded border border-[#fff8c5] bg-[#fff8c5] p-2 text-sm">
                  {attribution.suggestedFix}
                </p>
              </div>
            )}
            <div>
              <div className="text-xs text-gh-muted">证据引用</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {attribution.evidenceRefs.map((ref) => (
                  <Tag key={ref} className="font-mono">
                    {ref}
                  </Tag>
                ))}
              </div>
            </div>
            {evidence !== undefined && evidence.codeLocations.length > 0 && (
              <div>
                <div className="text-xs text-gh-muted">代码文件/行候选（非确定结论）</div>
                <ul className="mt-1 space-y-1 text-sm">
                  {evidence.codeLocations.map((location) => (
                    <li key={`${location.path}-${location.line ?? 0}`}>
                      <code className="font-mono text-xs text-gh-blue">
                        {location.path}
                        {location.line === null ? '' : `:${location.line}`}
                      </code>
                      <span className="ml-2 text-gh-muted">{location.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      {runCase.repairs.length > 0 && (
        <Card title="修复尝试">
          <div className="space-y-4">
            {runCase.repairs.map((repair) => (
              <div key={repair.id} className="rounded border border-gh-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag>#{repair.attemptNo}</Tag>
                  <Tag color="blue">{repair.repairClass}</Tag>
                  <Tag
                    color={
                      repair.guardStatus === 'allowed'
                        ? 'green'
                        : repair.guardStatus === 'blocked'
                          ? 'red'
                          : 'gold'
                    }
                  >
                    guard: {repair.guardStatus}
                  </Tag>
                  <Tag>{repair.reviewStatus}</Tag>
                  {repair.appliedCommit !== null && (
                    <code className="text-xs">{repair.appliedCommit.slice(0, 8)}</code>
                  )}
                  <div className="flex-1" />
                  {repair.reviewStatus === 'pending' && repair.guardStatus !== 'blocked' && (
                    <PermissionGate permission={PERMISSION.REPAIR_APPROVE}>
                      <Space>
                        <Popconfirm
                          title="批准并提交修复"
                          description="会将补丁提交到 Suite 仓库；建议随后新建 Run 验证。"
                          okText="批准"
                          cancelText="取消"
                          onConfirm={() => void repairAction('approve', repair.id)}
                        >
                          <Button type="primary" size="small" loading={repairing}>
                            批准
                          </Button>
                        </Popconfirm>
                        <Button
                          size="small"
                          loading={repairing}
                          onClick={() => void repairAction('reject', repair.id)}
                        >
                          拒绝
                        </Button>
                      </Space>
                    </PermissionGate>
                  )}
                  {repair.appliedCommit !== null && (
                    <PermissionGate permission={PERMISSION.REPAIR_APPROVE}>
                      <Popconfirm
                        title="回滚修复"
                        description="将把原始 feature 内容重新提交到 Suite。"
                        okText="回滚"
                        okButtonProps={{ danger: true }}
                        cancelText="取消"
                        onConfirm={() => void repairAction('rollback', repair.id)}
                      >
                        <Button danger size="small" loading={repairing}>
                          回滚
                        </Button>
                      </Popconfirm>
                    </PermissionGate>
                  )}
                </div>
                <p className="mt-2 text-sm">{repair.rationale}</p>
                {repair.featurePath !== null && (
                  <code className="text-xs text-gh-muted">{repair.featurePath}</code>
                )}
                {repair.patchDiff !== null && (
                  <Collapse
                    className="mt-2"
                    size="small"
                    items={[
                      {
                        key: 'diff',
                        label: '补丁 diff',
                        children: (
                          <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">
                            {repair.patchDiff}
                          </pre>
                        ),
                      },
                    ]}
                  />
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="步骤时间线">
        <StepTimeline runId={data.id} steps={steps} />
      </Card>

      {evidence !== undefined && (
        <Card title="证据包">
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <Tag>端点 {evidence.signals.endpoints.join(', ') || '-'}</Tag>
            <Tag>选择器 {evidence.signals.selectors.join(', ') || '-'}</Tag>
            <Tag>用例文件变更 {evidence.signals.testFilesChanged ? '是' : '否'}</Tag>
            <Tag>产品文件变更 {evidence.signals.productFilesChanged ? '是' : '否'}</Tag>
            <Tag>代码关联置信度 {Math.round(evidence.signals.codeTouchConfidence * 100)}%</Tag>
            <Tag>采集时间 {new Date(evidence.collectedAt).toLocaleString('zh-CN')}</Tag>
          </div>

          <Collapse
            items={[
              {
                key: 'history',
                label: `历史结果（${evidence.history.length}）`,
                children:
                  evidence.history.length === 0 ? (
                    <p className="text-sm text-gh-muted">暂无历史基线。</p>
                  ) : (
                    <Table
                      size="small"
                      rowKey="runId"
                      pagination={false}
                      dataSource={evidence.history}
                      columns={[
                        { title: 'Run', dataIndex: 'runId' },
                        {
                          title: 'Commit',
                          dataIndex: 'headSha',
                          render: (sha: string) => (
                            <code className="text-xs">{sha.slice(0, 8)}</code>
                          ),
                        },
                        { title: '结果', dataIndex: 'caseStatus' },
                        { title: '分类', dataIndex: 'classification' },
                      ]}
                    />
                  ),
              },
              {
                key: 'diff',
                label: `相关变更（${evidence.diff.files.length}）`,
                children:
                  evidence.diff.files.length === 0 ? (
                    <p className="text-sm text-gh-muted">没有可用 diff。</p>
                  ) : (
                    <Collapse
                      size="small"
                      items={evidence.diff.files.map((file, index) => ({
                        key: `${file.path}-${index}`,
                        label: (
                          <span className="flex items-center gap-2">
                            <code className="text-xs">{file.path}</code>
                            <Tag>{file.category}</Tag>
                            <Tag>{file.status}</Tag>
                          </span>
                        ),
                        children: (
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-gh-canvas p-2 font-mono text-xs">
                            {file.hunks
                              .map((hunk) => `${hunk.header}\n${hunk.content}`)
                              .join('\n\n')}
                          </pre>
                        ),
                      }))}
                    />
                  ),
              },
              {
                key: 'logs',
                label: `日志尾部（${evidence.logs.length}）`,
                children:
                  evidence.logs.length === 0 ? (
                    <p className="text-sm text-gh-muted">没有日志产物。</p>
                  ) : (
                    evidence.logs.map((log) => (
                      <pre
                        key={`${log.source}-${log.artifactId}`}
                        className="mb-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-gh-canvas p-2 font-mono text-xs"
                      >
                        {log.tail}
                      </pre>
                    ))
                  ),
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
}
