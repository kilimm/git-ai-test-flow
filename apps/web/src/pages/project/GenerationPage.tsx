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
  Sparkles,
  Plus,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { PERMISSION } from '@gait/shared';
import type { FeaturePoint } from '@gait/shared';
import { api, ApiError } from '../../api/client';
import type { CaseModuleNode, GenerationDetail, GenerationFile } from '../../api/types';
import type { ModuleTreeNode } from '@gait/shared';
import DiffViewer from '../../components/DiffViewer';
import EmptyState from '../../components/EmptyState';
import ErrorState from '../../components/ErrorState';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import ModulePicker from '../../components/ModulePicker';
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
  moduleSelection?: string[];
  /** 额外需求说明，注入各阶段提示词。 */
  extraInstructions?: string;
}

/** 「一键生成初始用例集」表单：忽略 diff，对代码库现状全量分析。 */
interface BaselineFormValues {
  branch?: string;
  headSha?: string;
  granularity: 'high' | 'medium' | 'low';
  modules?: string;
  moduleSelection?: string[];
  extraInstructions?: string;
}

const GRANULARITY_OPTIONS: { value: BaselineFormValues['granularity']; label: string }[] = [
  { value: 'high', label: '高（覆盖所有可能报错的分支）' },
  { value: 'medium', label: '中（核心功能的所有报错分支，推荐）' },
  { value: 'low', label: '低（核心功能的主流程）' },
];

/**
 * 模块选择 → selection.modules：
 * - 手填模块（逗号分隔）+ 树选择合并；
 * - 为空时不传 selection，表示全部模块；
 * - 层级 key 原样传给后端，由后端做前缀匹配（posts 命中 posts.comments）。
 */
function moduleSelectionOf(values: { moduleSelection?: string[]; modules?: string }): string[] {
  const manual = (values.modules ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return [...new Set([...(values.moduleSelection ?? []), ...manual])];
}

function granularityLabel(value: string): string {
  return GRANULARITY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}


/**
 * 用例侧模块树（按 @module 标签聚合）→ 生成表单用的模块树。
 * 新建任务时优先复用它：代码扫描得到的模块 key 常常和用例里已使用的模块不一致，
 * 复用已有模块能保证生成产物落在同一模块、与现有用例合并而不是新建目录。
 */
function modulesFromCases(nodes: readonly CaseModuleNode[], prefix = ''): ModuleTreeNode[] {
  return nodes.map((node) => {
    const key = prefix.length === 0 ? node.key : `${prefix}.${node.key}`;

    return {
      key,
      label: node.label,
      featurePoints: node.caseCount,
      children: modulesFromCases(node.children, key),
    } as ModuleTreeNode;
  });
}

/** 生成详情 stats.modules → 模块树（容错：旧数据没有该字段）。 */
function modulesOf(generation: GenerationDetail): ModuleTreeNode[] {
  const raw = generation.stats?.modules;

  return Array.isArray(raw) ? (raw as ModuleTreeNode[]) : [];
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
          <Tag key={module} className="font-mono">
            {module}
          </Tag>
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
  const [baselineForm] = Form.useForm<BaselineFormValues>();
  const [createOpen, setCreateOpen] = useState(false);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<GenerationFile | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [acting, setActing] = useState(false);
  const [modules, setModules] = useState<ModuleTreeNode[]>([]);
  const [modulesLoading, setModulesLoading] = useState(false);
  const [modulesTruncated, setModulesTruncated] = useState(false);
  /** 模块清单来源：cases=用例库已有模块（默认），code=代码扫描结果。 */
  const [modulesSource, setModulesSource] = useState<'cases' | 'code'>('cases');
  const mode = Form.useWatch('mode', form);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const list = useAsync(() => api.listGenerations(project.id, { page, pageSize }), [
    project.id,
    page,
  ]);
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

  /**
   * 模块清单来源优先级：
   * 1) 用例库已有模块（复用，保证生成产物落到同一模块）；
   * 2) 代码扫描结果（用例库还没有模块时的兜底）。
   */
  const refreshModules = async (): Promise<void> => {
    const [caseModules, scanned] = await Promise.all([
      api.listCaseModules(project.id).catch(() => [] as CaseModuleNode[]),
      api.listProjectModules(project.id).catch(() => null),
    ]);

    const fromCases = modulesFromCases(caseModules);

    if (fromCases.length > 0) {
      setModules(fromCases);
      setModulesSource('cases');
      setModulesTruncated(false);

      return;
    }

    setModules(scanned?.modules ?? []);
    setModulesSource('code');
    setModulesTruncated(scanned?.truncated ?? false);
  };

  /** 打开表单时按需拉取模块清单；若为空则说明 Worker 还没扫描过。 */
  const openCreateForm = (): void => {
    setCreateOpen(true);
    void refreshModules();
  };

  const openBaselineForm = (): void => {
    setBaselineOpen(true);
    void refreshModules();
  };

  const scanModules = async (): Promise<void> => {
    setModulesLoading(true);

    try {
      await api.scanProjectModules(project.id);
      // 扫描是异步 job；轮询几次等 Worker 写回。
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const result = await api.listProjectModules(project.id);

        if (result.modules.length > 0) {
          setModules(result.modules);
          setModulesTruncated(result.truncated);
          setModulesSource('code');
          message.success(`已识别 ${result.modules.length} 个顶层模块（代码库扫描结果）`);
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

  const create = async (values: CreateFormValues): Promise<void> => {
    setCreating(true);

    try {
      const modules = moduleSelectionOf(values);
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
        ...(values.extraInstructions !== undefined && values.extraInstructions.trim().length > 0
          ? { extraInstructions: values.extraInstructions.trim() }
          : {}),
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

  const createBaseline = async (values: BaselineFormValues): Promise<void> => {
    setCreating(true);

    try {
      const modules = moduleSelectionOf(values);
      const result = await api.createGeneration(project.id, {
        mode: 'baseline',
        granularity: values.granularity,
        ...(values.headSha === undefined || values.headSha.trim() === ''
          ? { branch: values.branch?.trim() ?? project.defaultBranch }
          : { headSha: values.headSha.trim() }),
        ...(modules.length > 0 ? { selection: { modules } } : {}),
        ...(values.extraInstructions !== undefined && values.extraInstructions.trim().length > 0
          ? { extraInstructions: values.extraInstructions.trim() }
          : {}),
      });

      message.success(result.created ? '初始用例集生成任务已创建' : '已存在相同的初始用例集任务');
      setBaselineOpen(false);
      baselineForm.resetFields();
      list.reload();
      setSelectedId(result.generation.id);
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '创建初始用例集失败');
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
              <Button
                icon={<Sparkles size={15} />}
                onClick={openBaselineForm}
                title="忽略当前 diff，对整个代码库现状做全量分析并生成初始用例集"
              >
                一键生成初始用例集
              </Button>
              <Button type="primary" icon={<Plus size={15} />} onClick={openCreateForm}>
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
              dataSource={list.data?.items ?? []}
              locale={{ emptyText: '暂无生成任务' }}
              pagination={
                (list.data?.total ?? 0) > pageSize
                  ? {
                      current: page,
                      pageSize,
                      total: list.data?.total ?? 0,
                      size: 'small',
                      showSizeChanger: false,
                      onChange: (next) => setPage(next),
                    }
                  : false
              }
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
                        {item.mode === 'baseline' ? `初始·${item.granularity} · ` : ''}
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
                      key: 'mode',
                      label: '模式',
                      children:
                        generation.mode === 'baseline'
                          ? 'baseline（全量代码库快照）'
                          : generation.mode,
                    },
                    {
                      key: 'granularity',
                      label: '颗粒度',
                      children: granularityLabel(generation.granularity),
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
                      key: 'modules',
                      label: '识别模块',
                      children:
                        modulesOf(generation).length === 0
                          ? '-'
                          : modulesOf(generation)
                              .map((node) => node.key)
                              .join(', '),
                    },
                    {
                      key: 'extra',
                      label: '额外需求',
                      children:
                        generation.extraInstructions === undefined ||
                        generation.extraInstructions.length === 0 ? (
                          '-'
                        ) : (
                          <span className="whitespace-pre-wrap text-xs">
                            {generation.extraInstructions}
                          </span>
                        ),
                    },
                    {
                      key: 'stats',
                      label: '统计',
                      children: `${generation.featurePoints.length} 功能点 / ${
                        generation.files?.length ?? 0
                      } 文件`,
                    },
                  ]}
                />

                {generation.stats?.incomplete === true && (
                  <Alert
                    className="mt-3"
                    type="warning"
                    showIcon
                    message="本次分析未覆盖全部文件（超出 diff 预算或文件数上限）"
                    description={`已纳入 ${String(generation.stats.filesIncluded ?? '-')} 个文件，跳过 ${String(
                      generation.stats.filesSkipped ?? '-',
                    )} 个，截断 ${String(
                      generation.stats.filesTruncated ?? '-',
                    )} 个。可缩小模块过滤范围后分批生成。`}
                  />
                )}
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
          <Form.Item
            name="moduleSelection"
            label="模块（可选，不选=全部）"
            tooltip="选择父模块会包含其全部子模块；可手填层级 key，如 posts.comments"
          >
            <ModulePicker
              modules={modules}
              loading={modulesLoading}
              truncation={modulesTruncated}
              source={modulesSource}
              onScan={() => {
                void scanModules();
              }}
              compact
            />
          </Form.Item>
          <Form.Item
            name="modules"
            label="手动补充模块 key（逗号分隔，可选）"
            tooltip="用于模块清单里没有的模块；与上方选择合并"
          >
            <Input placeholder="posts.comments, auth" />
          </Form.Item>
          <Form.Item
            name="extraInstructions"
            label="额外需求（可选）"
            tooltip="会作为用户需求注入摘要/提取/设计/评审各阶段，针对性地补充用例"
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              maxLength={4000}
              showCount
              placeholder={'例如：请确保用户上传的图片不超过 500*500\n补充：删除留言后列表应立即刷新'}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={baselineOpen}
        title="一键生成初始用例集"
        okText="开始生成"
        cancelText="取消"
        confirmLoading={creating}
        onCancel={() => setBaselineOpen(false)}
        onOk={() => baselineForm.submit()}
        destroyOnHidden
      >
        <Alert
          className="mb-3"
          type="info"
          showIcon
          message="忽略当前 diff，对整个代码库现状做全量分析"
          description="适用于代码已全部提交、需要为现有系统建立基线用例的场景。大仓库建议先按模块过滤分批生成。"
        />
        <Form<BaselineFormValues>
          form={baselineForm}
          layout="vertical"
          requiredMark={false}
          initialValues={{ granularity: 'medium' }}
          onFinish={(values) => {
            void createBaseline(values);
          }}
        >
          <Form.Item name="granularity" label="生成颗粒度" rules={[{ required: true }]}>
            <Radio.Group optionType="button" buttonStyle="solid" options={GRANULARITY_OPTIONS} />
          </Form.Item>
          <Form.Item name="branch" label="分支（默认项目默认分支）">
            <Input placeholder={project.defaultBranch} />
          </Form.Item>
          <Form.Item
            name="headSha"
            label="指定 Commit（可选，填写后忽略分支）"
            rules={[{ pattern: /^[0-9a-f]{7,64}$/i, message: '请输入合法 Commit SHA' }]}
          >
            <Input placeholder="HEAD 或指定 commit" />
          </Form.Item>
          <Form.Item
            name="moduleSelection"
            label="模块（可选，不选=全部）"
            tooltip="选择父模块会包含其全部子模块；可手填层级 key，如 posts.comments"
          >
            <ModulePicker
              modules={modules}
              loading={modulesLoading}
              truncation={modulesTruncated}
              source={modulesSource}
              onScan={() => {
                void scanModules();
              }}
            />
          </Form.Item>
          <Form.Item
            name="modules"
            label="手动补充模块 key（逗号分隔，可选）"
            tooltip="用于模块清单里没有的模块；与上方选择合并"
          >
            <Input placeholder="posts.comments, auth" />
          </Form.Item>
          <Form.Item
            name="extraInstructions"
            label="额外需求（可选）"
            tooltip="会作为用户需求注入摘要/提取/设计/评审各阶段，针对性地补充用例"
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              maxLength={4000}
              showCount
              placeholder={'例如：请确保用户上传的图片不超过 500*500\n补充：删除留言后列表应立即刷新'}
            />
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
