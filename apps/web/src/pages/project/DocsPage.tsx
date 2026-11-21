// 本文件所有改动要求遵循 agent-rules 规范
import { useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { BookOpen, GitCompare, Pencil, RefreshCw, Shrink } from 'lucide-react';
import { PERMISSION } from '@gait/shared';
import { api, ApiError } from '../../api/client';
import type { DocCommitEntryRecord, DocModuleRecord, DocVersionRecord } from '../../api/types';
import EmptyState from '../../components/EmptyState';
import ErrorState from '../../components/ErrorState';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import MarkdownView from '../../components/MarkdownView';
import PageHeader from '../../components/PageHeader';
import PermissionGate from '../../components/PermissionGate';
import { useProject } from '../../components/ProjectLayout';
import { useAsync } from '../../hooks/useAsync';

const { TextArea } = Input;

export default function DocsPage() {
  const { project } = useProject();
  const { message } = AntdApp.useApp();
  const [selectedModuleId, setSelectedModuleId] = useState<string | undefined>(undefined);
  const [fromVersionId, setFromVersionId] = useState<string | undefined>(undefined);
  const [diff, setDiff] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const {
    data: modules,
    loading,
    error,
    reload,
  } = useAsync(() => api.listDocModules(project.id), [project.id]);
  const { data: entries } = useAsync(() => api.listDocEntries(project.id), [project.id]);

  useEffect(() => {
    if (selectedModuleId === undefined && modules !== undefined && modules.length > 0) {
      setSelectedModuleId(modules[0]?.id);
    }
  }, [modules, selectedModuleId]);

  const {
    data: detail,
    loading: detailLoading,
    reload: reloadDetail,
  } = useAsync(
    () =>
      selectedModuleId === undefined ? Promise.resolve(null) : api.getDocModule(selectedModuleId),
    [selectedModuleId],
  );
  const { data: versions, reload: reloadVersions } = useAsync(
    () =>
      selectedModuleId === undefined
        ? Promise.resolve([] as DocVersionRecord[])
        : api.listDocVersions(selectedModuleId),
    [selectedModuleId],
  );

  const selectedModule: DocModuleRecord | undefined = modules?.find(
    (item) => item.id === selectedModuleId,
  );
  const reloadAll = (): void => {
    reload();
    reloadDetail();
    reloadVersions();
  };

  const enqueue = async (kind: 'regenerate' | 'compress'): Promise<void> => {
    try {
      await (kind === 'regenerate' ? api.regenerateDocs(project.id) : api.compressDocs(project.id));

      message.success(
        kind === 'regenerate'
          ? '文档同步任务已入队，完成后刷新查看'
          : '文档压缩任务已入队，完成后刷新查看',
      );
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '任务创建失败');
    }
  };

  const compare = async (): Promise<void> => {
    if (selectedModuleId === undefined || versions === undefined || versions.length === 0) {
      return;
    }

    const from = fromVersionId ?? versions[1]?.id ?? versions[0]?.id;
    const to = versions[0]?.id;

    if (from === undefined || to === undefined) {
      return;
    }

    try {
      const result = await api.docDiff(selectedModuleId, from, to);
      setDiff(result.diff);
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '版本对比失败');
    }
  };

  const openEdit = (): void => {
    if (detail?.version === null || detail?.version === undefined) {
      return;
    }

    setEditContent(detail.version.contentMd);
    setEditOpen(true);
  };

  const saveEdit = async (): Promise<void> => {
    if (selectedModuleId === undefined) {
      return;
    }

    setSaving(true);

    try {
      await api.editDoc(selectedModuleId, editContent);
      message.success('文档已提交到 Suite');
      setEditOpen(false);
      reloadAll();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const actions = (
    <PermissionGate permission={PERMISSION.DOC_EDIT}>
      <Space wrap>
        <Button icon={<RefreshCw size={15} />} onClick={() => void enqueue('regenerate')}>
          重新同步
        </Button>
        <Button icon={<Shrink size={15} />} onClick={() => void enqueue('compress')}>
          压缩历史
        </Button>
        <Button icon={<Pencil size={15} />} disabled={detail?.version == null} onClick={openEdit}>
          编辑
        </Button>
      </Space>
    </PermissionGate>
  );

  if (loading && modules === undefined) {
    return <LoadingSkeleton rows={8} />;
  }

  if (error !== undefined) {
    return <ErrorState error={error} onRetry={reload} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="项目文档"
        description={`模块文档、T0 提交条目与压缩历史；Git 目录 ${project.docsRoot}`}
        actions={actions}
      />

      {(modules?.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            icon={<BookOpen size={40} className="mx-auto text-gh-muted" />}
            title="尚未生成模块文档"
            description="点击“重新同步”后，Worker 会读取产品仓库、映射模块并提交 docs/ai 文档。"
          />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={6}>
            <Card title="模块" size="small" styles={{ body: { padding: 8 } }}>
              {selectedModuleId !== undefined && (
                <Select
                  className="w-full"
                  value={selectedModuleId}
                  onChange={(value: string) => {
                    setSelectedModuleId(value);
                    setFromVersionId(undefined);
                    setDiff(null);
                  }}
                  options={(modules ?? []).map((module) => ({
                    value: module.id,
                    label: `${module.name} (${module.key})`,
                  }))}
                />
              )}
              <div className="mt-3 space-y-2">
                {(modules ?? []).map((module) => (
                  <button
                    key={module.id}
                    type="button"
                    className={`w-full rounded border px-2 py-2 text-left text-xs ${
                      module.id === selectedModuleId
                        ? 'border-gh-blue bg-[#ddf4ff]'
                        : 'border-gh-border hover:bg-gh-canvas'
                    }`}
                    onClick={() => {
                      setSelectedModuleId(module.id);
                      setDiff(null);
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{module.name}</span>
                      <Badge status={module.status === 'active' ? 'success' : 'warning'} />
                    </div>
                    <div className="mt-1 text-gh-muted">{module.key}</div>
                  </button>
                ))}
              </div>
            </Card>
          </Col>
          <Col xs={24} lg={18}>
            <Card
              title={selectedModule?.name ?? '模块文档'}
              size="small"
              extra={
                detail?.version !== null && detail?.version !== undefined ? (
                  <Space>
                    <Tag>{detail.version.tokenCount} tokens</Tag>
                    {detail.version.humanEdited && <Tag color="green">人工编辑</Tag>}
                    <Tag color="blue">{detail.version.commitSha.slice(0, 8)}</Tag>
                  </Space>
                ) : null
              }
              loading={detailLoading}
            >
              {detail?.version === null || detail?.version === undefined ? (
                <EmptyState title="暂无文档版本" description="重新同步后生成首版文档。" />
              ) : (
                <div className="max-h-[620px] overflow-auto pr-2">
                  <MarkdownView content={detail.version.contentMd} />
                </div>
              )}
            </Card>
          </Col>
        </Row>
      )}

      {diff !== null && (
        <Card
          title="版本对比"
          size="small"
          extra={<Button onClick={() => setDiff(null)}>关闭</Button>}
        >
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap text-xs">{diff}</pre>
        </Card>
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="版本历史" size="small">
            <Table<DocVersionRecord>
              rowKey="id"
              size="small"
              pagination={{ pageSize: 6 }}
              dataSource={versions ?? []}
              locale={{ emptyText: '暂无版本' }}
              columns={[
                {
                  title: '提交',
                  dataIndex: 'commitSha',
                  render: (sha: string) => <code className="text-xs">{sha.slice(0, 8)}</code>,
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  render: (status: string) => <Tag>{status}</Tag>,
                },
                {
                  title: '时间',
                  dataIndex: 'createdAt',
                  render: (value: string) => new Date(value).toLocaleString('zh-CN'),
                },
                {
                  title: '',
                  width: 160,
                  render: (_value, version) => (
                    <Space>
                      <Button
                        size="small"
                        onClick={() => {
                          setFromVersionId(version.id);
                          message.info('已设为对比起点');
                        }}
                      >
                        设为起点
                      </Button>
                      <Button
                        size="small"
                        icon={<GitCompare size={12} />}
                        onClick={() => void compare()}
                      >
                        对比
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="T0 提交条目（最近 100 条）" size="small">
            <Table<DocCommitEntryRecord>
              rowKey="id"
              size="small"
              pagination={{ pageSize: 6 }}
              dataSource={entries ?? []}
              locale={{ emptyText: '暂无提交条目' }}
              columns={[
                {
                  title: 'Commit',
                  dataIndex: 'commitSha',
                  render: (sha: string) => <code className="text-xs">{sha.slice(0, 8)}</code>,
                },
                { title: '标题', dataIndex: 'title' },
                {
                  title: '模块',
                  dataIndex: 'modules',
                  render: (values: string[]) =>
                    values.map((value) => <Tag key={value}>{value}</Tag>),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      {(entries?.length ?? 0) > 100 && (
        <Alert
          type="info"
          showIcon
          message="更早历史已压缩为 T1-T3 摘要，原始 T0 条目仍永久保留在数据库。"
        />
      )}

      <Collapse
        items={[
          {
            key: 'compression',
            label: '压缩说明',
            children: (
              <p className="text-sm text-gh-muted">
                最近 100 次提交保留完整 T0；第 101-500 次按 10 条合并为 T1，第 501-2000 次按月合并为
                T2，更早按年合并为 T3。压缩只影响展示与 LLM 上下文，源条目不会删除。
              </p>
            ),
          },
        ]}
      />

      <Modal
        open={editOpen}
        title="编辑模块文档"
        width={860}
        okText="提交到 Suite"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => setEditOpen(false)}
        onOk={() => void saveEdit()}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          className="mb-3"
          message="人工编辑后，后续自动同步会提出冲突而不会静默覆盖。"
        />
        <TextArea
          value={editContent}
          onChange={(event) => setEditContent(event.target.value)}
          autoSize={{ minRows: 16, maxRows: 30 }}
          className="font-mono text-xs"
        />
      </Modal>
    </div>
  );
}
