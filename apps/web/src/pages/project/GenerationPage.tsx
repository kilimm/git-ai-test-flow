// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Form,
  Input,
  List,
  Modal,
  Radio,
  Row,
  Tag,
} from 'antd';
import {
  CheckCircle2,
  Clock3,
  GitPullRequest,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { PERMISSION } from '@gait/shared';
import type { FeaturePoint } from '@gait/shared';
import { api, ApiError } from '../../api/client';
import type { GenerationDetail, GenerationFile } from '../../api/types';
import DiffViewer from '../../components/DiffViewer';
import EmptyState from '../../components/EmptyState';
import ErrorState from '../../components/ErrorState';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import PageHeader from '../../components/PageHeader';
import PermissionGate from '../../components/PermissionGate';
import StatusBadge from '../../components/StatusBadge';
import { useProject } from '../../components/ProjectLayout';
import { useAsync } from '../../hooks/useAsync';
import { useEventStream } from '../../hooks/useEventStream';
import { usePolling } from '../../hooks/usePolling';

interface CreateFormValues {
  mode: 'current' | 'range';
  baseSha?: string;
  headSha?: string;
  branch?: string;
  modules?: string;
}

function riskColor(risk: string): string {
  return risk === 'high' ? 'red' : risk === 'medium' ? 'gold' : 'green';
}

function FeaturePointCard({ point }: { point: FeaturePoint }) {
  return (
    <Card size="small" className="h-full">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-gh-text">{point.title}</span>
        <Tag color={riskColor(point.risk)}>{point.risk}</Tag>
      </div>
      <p className="mt-1 text-xs text-gh-muted">{point.description}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {point.affectedModules.map((module) => (
          <Tag key={module}>{module}</Tag>
        ))}
        {point.suggestedLayer.map((layer) => (
          <Tag key={layer} color="blue">
            {layer}
          </Tag>
        ))}
      </div>
    </Card>
  );
}

export default function GenerationPage() {
  const { project } = useProject();
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<CreateFormValues>();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<GenerationFile | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [acting, setActing] = useState(false);
  const mode = Form.useWatch('mode', form);
  const list = useAsync(() => api.listGenerations(project.id), [project.id]);
  const detail = useAsync(
    () => (selectedId === null ? Promise.resolve(undefined) : api.getGeneration(selectedId)),
    [selectedId],
  );
  const generation: GenerationDetail | undefined = detail.data ?? undefined;
  const shouldPoll =
    generation !== undefined && ['queued', 'running', 'validating'].includes(generation.status);

  usePolling(detail.reload, 3_000, shouldPoll);
  useEventStream(
    selectedId === null ? undefined : api.generationEventsUrl(selectedId),
    () => {
      detail.reload();
      list.reload();
    },
    shouldPoll,
  );

  const select = (id: string): void => {
    setSelectedId(id);
  };

  const create = async (values: CreateFormValues): Promise<void> => {
    setCreating(true);

    try {
      const modules = (values.modules ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const result = await api.createGeneration(project.id, {
        mode: values.mode,
        ...(values.mode === 'range'
          ? {
              ...(values.baseSha === undefined ? {} : { baseSha: values.baseSha }),
              ...(values.headSha === undefined ? {} : { headSha: values.headSha }),
            }
          : {
              ...(values.headSha === undefined ? {} : { headSha: values.headSha }),
              ...(values.branch === undefined ? {} : { branch: values.branch }),
            }),
        ...(modules.length > 0 ? { selection: { modules } } : {}),
      });

      message.success(result.created ? '生成任务已创建' : '已存在相同生成任务');
      setCreateOpen(false);
      form.resetFields();
      list.reload();
      setSelectedId(result.generation.id);
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '创建生成任务失败');
    } finally {
      setCreating(false);
    }
  };

  const saveFile = async (): Promise<void> => {
    if (generation === null || generation === undefined || editingFile === null) {
      return;
    }

    setEditSaving(true);

    try {
      await api.editGenerationFile(generation.id, editingFile.id, editContent);
      message.success('草稿已保存并重新校验');
      setEditingFile(null);
      detail.reload();
      list.reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '保存草稿失败');
    } finally {
      setEditSaving(false);
    }
  };

  const approve = (): void => {
    if (generation === undefined) {
      return;
    }

    modal.confirm({
      title: '批准并提交 Suite',
      content: '平台会重新校验所有草稿，然后提交到 Suite 仓库。',
      okText: '批准并提交',
      cancelText: '取消',
      onOk: async () => {
        setActing(true);

        try {
          const result = await api.approveGeneration(generation.id);
          message.success(
            result.commit.changed
              ? `已提交 Suite：${result.commit.commitSha.slice(0, 8)}`
              : '草稿无变化，未产生新提交',
          );
          detail.reload();
          list.reload();
        } catch (cause) {
          message.error(cause instanceof ApiError ? cause.message : '审批失败');
        } finally {
          setActing(false);
        }
      },
    });
  };

  const reject = (): void => {
    if (generation === undefined) {
      return;
    }

    modal.confirm({
      title: '拒绝生成结果',
      content: '拒绝后不会提交 Suite；如需重新生成请再次创建任务。',
      okText: '拒绝',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setActing(true);

        try {
          await api.rejectGeneration(generation.id);
          message.success('已拒绝生成结果');
          detail.reload();
          list.reload();
        } catch (cause) {
          message.error(cause instanceof ApiError ? cause.message : '拒绝失败');
        } finally {
          setActing(false);
        }
      },
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="变更与生成"
        description="从 Git diff 识别功能点并生成 Gherkin 用例；审批后提交 Suite"
        actions={
          <>
            <Button icon={<RefreshCw size={15} />} onClick={list.reload}>
              刷新
            </Button>
            <PermissionGate permission={PERMISSION.GENERATION_CREATE}>
              <Button type="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>
                新建生成任务
              </Button>
            </PermissionGate>
          </>
        }
      />

      {list.error !== undefined && <ErrorState error={list.error} onRetry={list.reload} />}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={7}>
          <Card title="生成任务" styles={{ body: { padding: 0 } }}>
            <List
              loading={list.loading && list.data === undefined}
              dataSource={list.data ?? []}
              locale={{ emptyText: '暂无生成任务' }}
              renderItem={(item) => (
                <List.Item
                  className={`cursor-pointer px-3 ${selectedId === item.id ? 'bg-[#ddf4ff]' : ''}`}
                  onClick={() => select(item.id)}
                >
                  <div className="w-full">
                    <div className="flex items-center justify-between gap-2">
                      <code className="font-mono text-xs">{item.headSha.slice(0, 8)}</code>
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-gh-muted">
                      <span>
                        {item.featurePoints.length} 功能点 ·{' '}
                        {new Date(item.createdAt).toLocaleString('zh-CN')}
                      </span>
                      <Tag color={item.approvalStatus === 'pending' ? 'gold' : 'default'}>
                        {item.approvalStatus}
                      </Tag>
                    </div>
                  </div>
                </List.Item>
              )}
            />
          </Card>
        </Col>

        <Col xs={24} lg={17}>
          {selectedId === null && (
            <Card>
              <EmptyState
                icon={<GitPullRequest size={40} className="mx-auto text-gh-muted" />}
                title="选择或创建生成任务"
                description="生成任务会分析提交范围、提取功能点，并给出可审阅的 feature 草稿。"
              />
            </Card>
          )}

          {selectedId !== null && detail.loading && generation === undefined && <LoadingSkeleton />}
          {detail.error !== undefined && (
            <ErrorState error={detail.error} onRetry={detail.reload} />
          )}

          {generation !== undefined && (
            <div className="space-y-3">
              <Card>
                <Descriptions
                  size="small"
                  column={{ xs: 1, md: 2 }}
                  items={[
                    {
                      key: 'status',
                      label: '状态',
                      children: <StatusBadge status={generation.status} />,
                    },
                    {
                      key: 'approval',
                      label: '审批',
                      children: <Tag color="gold">{generation.approvalStatus}</Tag>,
                    },
                    {
                      key: 'range',
                      label: '提交范围',
                      children: (
                        <code className="font-mono text-xs">
                          {(generation.baseSha ?? 'current').slice(0, 8)} →{' '}
                          {generation.headSha.slice(0, 8)}
                        </code>
                      ),
                    },
                    { key: 'branch', label: '分支', children: generation.branch ?? '-' },
                    { key: 'model', label: '模型', children: generation.model ?? '-' },
                    {
                      key: 'stats',
                      label: '统计',
                      children: `${generation.featurePoints.length} 功能点 / ${
                        generation.files?.length ?? 0
                      } 文件`,
                    },
                  ]}
                />

                {shouldPoll && (
                  <Alert
                    className="mt-3"
                    type="info"
                    showIcon
                    icon={<Clock3 size={15} />}
                    message="生成进行中，页面每 3 秒刷新"
                  />
                )}
                {generation.error !== null && (
                  <Alert
                    className="mt-3"
                    type="error"
                    showIcon
                    message="生成失败"
                    description={JSON.stringify(generation.error)}
                  />
                )}

                {(generation.status === 'awaiting_approval' || acting) && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <PermissionGate permission={PERMISSION.GENERATION_APPROVE}>
                      <Button
                        type="primary"
                        icon={<CheckCircle2 size={15} />}
                        loading={acting}
                        disabled={generation.status !== 'awaiting_approval'}
                        onClick={approve}
                      >
                        批准并提交
                      </Button>
                      <Button
                        danger
                        icon={<XCircle size={15} />}
                        disabled={generation.status !== 'awaiting_approval'}
                        onClick={reject}
                      >
                        拒绝
                      </Button>
                    </PermissionGate>
                  </div>
                )}
              </Card>

              <Card title="功能点" size="small">
                {generation.featurePoints.length === 0 ? (
                  <EmptyState title="没有功能点" description="可能没有相关文件变更。" />
                ) : (
                  <Row gutter={[8, 8]}>
                    {generation.featurePoints.map((point) => (
                      <Col key={point.id} xs={24} md={12}>
                        <FeaturePointCard point={point} />
                      </Col>
                    ))}
                  </Row>
                )}
              </Card>

              <Card
                title="Feature 草稿"
                size="small"
                extra={<span className="text-xs text-gh-muted">只允许修改 features/**</span>}
              >
                {(generation.files ?? []).length === 0 ? (
                  <EmptyState title="暂无草稿" />
                ) : (
                  <Collapse
                    accordion
                    items={(generation.files ?? []).map((file) => ({
                      key: file.id,
                      label: (
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="text-xs">{file.path}</code>
                          <Tag>{file.action}</Tag>
                          <Tag color={file.validationStatus === 'valid' ? 'green' : 'red'}>
                            {file.validationStatus}
                          </Tag>
                          <span className="text-xs text-gh-muted">{file.scenarioCount} 场景</span>
                        </div>
                      ),
                      children: (
                        <div className="space-y-2">
                          <div className="flex justify-end">
                            <PermissionGate permission={PERMISSION.GENERATION_APPROVE}>
                              <Button
                                size="small"
                                icon={<Pencil size={13} />}
                                onClick={() => {
                                  setEditingFile(file);
                                  setEditContent(file.content);
                                }}
                              >
                                编辑
                              </Button>
                            </PermissionGate>
                          </div>
                          {file.validationErrors.length > 0 && (
                            <Alert
                              type="error"
                              showIcon
                              icon={<ShieldAlert size={15} />}
                              message="校验问题"
                              description={
                                <ul className="m-0 list-disc pl-4 text-xs">
                                  {file.validationErrors.map((issue, index) => (
                                    <li key={`${issue.code ?? 'issue'}-${index}`}>
                                      {issue.message ?? issue.code ?? '未知问题'}
                                    </li>
                                  ))}
                                </ul>
                              }
                            />
                          )}
                          <DiffViewer content={file.content} />
                        </div>
                      ),
                    }))}
                  />
                )}
              </Card>
            </div>
          )}
        </Col>
      </Row>

      <Modal
        open={createOpen}
        title="新建生成任务"
        okText="创建"
        cancelText="取消"
        confirmLoading={creating}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<CreateFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ mode: 'range' }}
          onFinish={(values) => {
            void create(values);
          }}
        >
          <Form.Item name="mode" label="模式" rules={[{ required: true }]}>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={[
                { value: 'range', label: 'range（提交范围）' },
                { value: 'current', label: 'current（工作区）' },
              ]}
            />
          </Form.Item>
          {mode === 'range' ? (
            <>
              <Form.Item name="baseSha" label="Base SHA" rules={[{ required: true }]}>
                <Input placeholder="base commit" />
              </Form.Item>
              <Form.Item name="headSha" label="Head SHA" rules={[{ required: true }]}>
                <Input placeholder="head commit" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="branch" label="Branch">
                <Input placeholder={project.defaultBranch} />
              </Form.Item>
              <Form.Item name="headSha" label="Head SHA（可选）">
                <Input placeholder="HEAD 或指定 commit" />
              </Form.Item>
            </>
          )}
          <Form.Item name="modules" label="模块过滤（逗号分隔，可选）">
            <Input placeholder="auth, posts" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={editingFile !== null}
        title="编辑 Feature 草稿"
        okText="保存并校验"
        cancelText="取消"
        width={860}
        confirmLoading={editSaving}
        onCancel={() => setEditingFile(null)}
        onOk={() => {
          void saveFile();
        }}
        destroyOnHidden
      >
        <Input.TextArea
          value={editContent}
          onChange={(event) => setEditContent(event.target.value)}
          autoSize={{ minRows: 16, maxRows: 28 }}
          className="font-mono"
        />
      </Modal>
    </div>
  );
}
