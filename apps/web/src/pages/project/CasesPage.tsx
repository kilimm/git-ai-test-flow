// 本文件所有改动要求遵循 agent-rules 规范
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Tree,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  FileEdit,
  FolderTree,
  FolderPlus,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { CaseFile, CaseFileDetail, CaseItem, CaseModuleNode } from '../../api/types';
import type { StepSuggestion } from '../../components/StepEditor';
import ErrorState from '../../components/ErrorState';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import PageHeader from '../../components/PageHeader';
import StatusBadge from '../../components/StatusBadge';
import StepEditor from '../../components/StepEditor';
import TerminalSteps from '../../components/TerminalSteps';
import { useProject } from '../../components/ProjectLayout';
import { useAsync } from '../../hooks/useAsync';

const MODULE_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** 模块归属前缀匹配：选中 posts 命中 posts 与 posts.comments，但不会命中 posts2。 */
function matchesModule(moduleKey: string | null | undefined, module: string): boolean {
  const key = moduleKey ?? 'unknown';

  return key === module || key.startsWith(`${module}.`);
}

/** antd Tree 节点附带原始模块信息。 */
interface ModuleTreeNodeData extends DataNode {
  /** 完整模块 key（如 api.messages），避免同名子节点（messages）互相串选。 */
  moduleKey: string;
  caseCount: number;
  children?: ModuleTreeNodeData[];
}

function toTreeData(nodes: readonly CaseModuleNode[], prefix = ''): ModuleTreeNodeData[] {
  return nodes.map((node) => {
    const moduleKey = prefix.length === 0 ? node.key : `${prefix}.${node.key}`;
    const result: ModuleTreeNodeData = {
      key: moduleKey,
      moduleKey,
      caseCount: node.caseCount,
      title: (
        <span className="inline-flex items-center gap-2">
          <span className="text-sm">{node.label}</span>
          <Tag className="m-0 font-mono text-[11px]">{node.caseCount}</Tag>
        </span>
      ),
    };

    if (node.children.length > 0) {
      result.children = toTreeData(node.children, moduleKey);
    }

    return result;
  });
}

/** 收集树中全部节点 key（包含子节点），用于生成父选项下拉。 */
function collectKeys(nodes: readonly CaseModuleNode[], prefix = ''): string[] {
  const result: string[] = [];

  for (const node of nodes) {
    const key = prefix.length === 0 ? node.key : `${prefix}.${node.key}`;
    result.push(key);
    result.push(...collectKeys(node.children, key));
  }

  return result;
}

/** 构造用于保存的完整 Gherkin 骨架（新增模块时用）。 */
function buildFeatureTemplate(moduleKey: string): string {
  return [
    `# language: en`,
    `@module:${moduleKey}`,
    `Feature: ${moduleKey}`,
    ``,
    `  @module:${moduleKey}`,
    `  Scenario: 基本功能可用`,
    `    Given 用户已访问应用首页`,
    `    Then 页面应正常显示`,
    ``,
  ].join('\n');
}

interface EditorState {
  path: string;
  content: string;
  detail: CaseFileDetail | null;
  dirty: boolean;
}

export default function CasesPage() {
  const { project } = useProject();
  const { message, modal } = AntdApp.useApp();
  const [search, setSearch] = useState('');
  const [moduleFilter, setModuleFilter] = useState<string | undefined>(undefined);
  const [selectedModule, setSelectedModule] = useState<string | undefined>(undefined);
  /** 模块树选中后按需拉取该模块下的文件与用例（索引里的 moduleKey 可能来自场景级旧标签，不可靠）。 */
  const [moduleDetail, setModuleDetail] = useState<{
    key: string;
    files: CaseFile[];
    cases: CaseItem[];
  } | null>(null);
  const [moduleLoading, setModuleLoading] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{ path: string; module: string } | null>(null);
  const [moduleAction, setModuleAction] = useState<
    | { type: 'rename'; key: string }
    | { type: 'delete'; key: string }
    | { type: 'add'; parent: string }
    | null
  >(null);
  const [moduleForm] = Form.useForm<{ key: string; deleteCases?: boolean }>();

  const { data, loading, error, reload } = useAsync(
    () =>
      Promise.all([
        api.listCases(project.id),
        api.listFeatureFiles(project.id),
        api.listCaseModules(project.id),
        api.listScriptSuggestions().catch(() => [] as StepSuggestion[]),
      ]),
    [project.id],
  );
  // 注意：这些 ?? [] 每次渲染都会新建数组，会让依赖它们的 useEffect 反复触发
  // （选中模块时表现为无限重新请求 → 页面卡顿）。用 useMemo 保持引用稳定。
  const cases = useMemo(() => data?.[0] ?? [], [data]);
  const files = useMemo(() => data?.[1] ?? [], [data]);
  const moduleTree = useMemo(() => data?.[2] ?? [], [data]);
  const suggestions = useMemo(() => data?.[3] ?? [], [data]);

  const modules = useMemo(() => collectKeys(moduleTree), [moduleTree]);


  const treeData = useMemo(() => toTreeData(moduleTree), [moduleTree]);

  /**
   * 选中模块时只发一次请求（/case-modules/snapshot）：
   * 服务端一次读取仓库文件内容 + 用例索引 + 模块树，避免前端 N 次读文件导致卡顿。
   */
  useEffect(() => {
    if (selectedModule === undefined) {
      setModuleDetail(null);

      return;
    }

    let cancelled = false;
    setModuleLoading(true);

    void (async () => {
      try {
        const snapshot = await api.moduleSnapshot(project.id, selectedModule);

        if (cancelled) {
          return;
        }

        const fileByPath = new Map(files.map((file) => [file.path, file]));

        setModuleDetail({
          key: selectedModule,
          files: snapshot.files
            .map((file) => fileByPath.get(file.path))
            .filter((file): file is CaseFile => file !== undefined),
          cases: snapshot.cases
            .map((item) => cases.find((existing) => existing.caseKey === item.caseKey))
            .filter((item): item is CaseItem => item !== undefined),
        });
      } catch (cause) {
        if (!cancelled) {
          message.error(cause instanceof ApiError ? cause.message : '模块用例加载失败');
        }
      } finally {
        if (!cancelled) {
          setModuleLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedModule, files, cases, project.id, message]);

  const filesOfSelectedModule =
    moduleDetail !== null && moduleDetail.key === selectedModule ? moduleDetail.files : files;
  const casesOfSelectedModule =
    moduleDetail !== null && moduleDetail.key === selectedModule ? moduleDetail.cases : cases;

  // 依据文件内容推断所属模块（编辑后 /case-files 会返回最新值）。
  const fileModuleOf = (file: CaseFile): string => file.moduleKey ?? 'unknown';

  const filtered = casesOfSelectedModule.filter((item) => {
    if (moduleFilter !== undefined && !matchesModule(item.moduleKey, moduleFilter)) {
      return false;
    }

    const keyword = search.trim().toLowerCase();

    return (
      keyword.length === 0 ||
      item.name.toLowerCase().includes(keyword) ||
      item.caseKey.toLowerCase().includes(keyword) ||
      item.featurePath.toLowerCase().includes(keyword)
    );
  });

  /** 场景可能来自索引里已失效的文件（历史残留），先确认文件仍存在再打开编辑器。 */
  const openCaseEditor = (featurePath: string): void => {
    const known = files.find((file) => file.path === featurePath);

    if (known !== undefined && known.missing === true) {
      message.warning('该场景所属文件已不在仓库中（索引为历史残留），请刷新列表');

      return;
    }

    void openEditor(featurePath);
  };

  const openEditor = async (path: string): Promise<void> => {
    try {
      const detail = await api.getCaseFile(project.id, path);
      setEditor({ path, content: detail.content, detail, dirty: false });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        message.warning('该用例文件已不在仓库中（索引为历史残留），请刷新列表后再试');
        reload();

        return;
      }

      message.error(cause instanceof ApiError ? cause.message : '无法读取用例文件');
    }
  };

  const guardDirty = (next: () => void): void => {
    if (editor === null || !editor.dirty) {
      next();

      return;
    }

    modal.confirm({
      title: '放弃未保存的修改？',
      content: '当前文件有未保存的改动，继续操作将丢弃这些修改。',
      okText: '放弃修改',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: next,
    });
  };

  const saveEditor = async (): Promise<void> => {
    if (editor === null) {
      return;
    }

    setSaving(true);

    try {
      const result = await api.saveCaseFile(project.id, editor.path, editor.content);
      message.success(
        result.parseStatus === 'parsed'
          ? `已保存（${result.scenarioCount} 个场景）`
          : '已保存，但文件解析有错误，请检查语法',
      );
      setEditor({ ...editor, dirty: false });
      reload();
      // 重新拉一次详情，更新解析状态与模块。
      try {
        const detail = await api.getCaseFile(project.id, editor.path);
        setEditor((previous) =>
          previous === null ? previous : { ...previous, detail, content: detail.content, dirty: false },
        );
      } catch {
        // 详情刷新失败不阻断保存反馈。
      }
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const submitMove = async (): Promise<void> => {
    if (moveTarget === null) {
      return;
    }

    if (!MODULE_KEY_PATTERN.test(moveTarget.module)) {
      message.error('模块 key 只能包含字母、数字、_ . -');
      return;
    }

    setSaving(true);

    try {
      const result = await api.moveCaseModule(project.id, moveTarget.path, moveTarget.module);
      message.success(`已移动到模块 ${result.to}（${result.touchedScenarios} 个场景）`);
      setMoveTarget(null);
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '移动失败');
    } finally {
      setSaving(false);
    }
  };

  const submitModuleAction = async (): Promise<void> => {
    if (moduleAction === null) {
      return;
    }

    const values = await moduleForm.validateFields();

    if (moduleAction.type === 'add') {
      const moduleKey =
        moduleAction.parent.length === 0 ? values.key : `${moduleAction.parent}.${values.key}`;

      if (!MODULE_KEY_PATTERN.test(moduleKey)) {
        message.error('模块 key 只能包含字母、数字、_ . -');
        return;
      }

      const featureRoot = project.featureRoot.replace(/\/+$/, '');
      const path = `${featureRoot}/${moduleKey.replace(/\./g, '/')}.feature`;
      setModuleAction(null);
      moduleForm.resetFields();
      setEditor({ path, content: buildFeatureTemplate(moduleKey), detail: null, dirty: true });
      message.info('已新建模块骨架，补充场景后保存即可');

      return;
    }

    setSaving(true);

    try {
      const operations =
        moduleAction.type === 'rename'
          ? [{ type: 'rename' as const, from: moduleAction.key, to: values.key }]
          : [
              {
                type: 'delete' as const,
                from: moduleAction.key,
                deleteCases: values.deleteCases === true,
              },
            ];
      const results = await api.editCaseModules(project.id, operations);
      const affected = results.reduce((total, item) => total + item.affectedFiles.length, 0);
      message.success(
        moduleAction.type === 'rename'
          ? `模块已重命名，影响 ${affected} 个文件`
          : `模块已处理，影响 ${affected} 个文件`,
      );
      setModuleAction(null);
      moduleForm.resetFields();
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '操作失败');
    } finally {
      setSaving(false);
    }
  };

  const preview = editor === null ? null : editor.content.split('\n').slice(0, 400);

  return (
    <div className="space-y-4">
      <PageHeader
        title="用例管理"
        description="在线编辑用例与数据文件、按模块组织用例；Git 仍是事实源"
        actions={
          <div className="flex flex-wrap gap-2">
            <Input
              allowClear
              prefix={<Search size={15} className="text-gh-muted" />}
              placeholder="搜索场景 / caseKey / 文件"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-64"
            />
            <Select
              allowClear
              placeholder="模块"
              className="w-40"
              value={moduleFilter}
              onChange={setModuleFilter}
              options={modules.map((module) => ({ value: module, label: module }))}
            />
          </div>
        }
      />

      {loading && data === undefined && <LoadingSkeleton />}
      {error !== undefined && <ErrorState error={error} onRetry={reload} />}

      {data !== undefined && (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <Card
            title={
              <span className="flex items-center gap-2">
                <FolderTree size={15} /> 模块目录树
              </span>
            }
            size="small"
            extra={
              <Space size={4}>
                <Button
                  size="small"
                  type="text"
                  icon={<FolderPlus size={13} />}
                  title="新建模块"
                  onClick={() => {
                    setModuleAction({ type: 'add', parent: selectedModule ?? '' });
                    moduleForm.setFieldsValue({ key: '' });
                  }}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<Pencil size={13} />}
                  title="重命名所选模块"
                  disabled={selectedModule === undefined}
                  onClick={() => {
                    if (selectedModule !== undefined) {
                      setModuleAction({ type: 'rename', key: selectedModule });
                      moduleForm.setFieldsValue({ key: selectedModule });
                    }
                  }}
                />
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<Trash2 size={13} />}
                  title="删除所选模块"
                  disabled={selectedModule === undefined}
                  onClick={() => {
                    if (selectedModule !== undefined) {
                      setModuleAction({ type: 'delete', key: selectedModule });
                      moduleForm.setFieldsValue({ key: selectedModule, deleteCases: false });
                    }
                  }}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<RefreshCw size={13} />}
                  title="刷新"
                  onClick={reload}
                />
              </Space>
            }
          >
            {moduleTree.length === 0 ? (
              <Empty
                image={
                  <FolderTree size={28} className="mx-auto text-gh-muted" />
                }
                imageStyle={{ height: 28 }}
                description="还没有可识别的模块；新建模块或生成用例后出现"
              />
            ) : (
              <div className="max-h-[28rem] overflow-auto rounded border border-gh-border p-2">
                <Tree
                  blockNode
                  defaultExpandAll
                  selectedKeys={selectedModule === undefined ? [] : [selectedModule]}
                  treeData={treeData}
                  onSelect={(keys, info) => {
                    if (!info.selected) {
                      // 再次点击同一节点 = 取消选择（回到全部模块）。
                      setSelectedModule(undefined);

                      return;
                    }

                    // 节点 key 已是完整模块路径（api.messages），不会与别的层级同名节点串选。
                    const key = keys[0];
                    setSelectedModule(typeof key === 'string' ? key : info.node.moduleKey);
                  }}
                />
              </div>
            )}
            {selectedModule !== undefined && (
              <Button
                size="small"
                type="link"
                className="mt-2 p-0"
                onClick={() => setSelectedModule(undefined)}
              >
                查看全部模块
              </Button>
            )}
          </Card>

          <div className="space-y-4">
            <Card
              title={`Feature 文件${selectedModule === undefined ? '' : `（模块 ${selectedModule}：${filesOfSelectedModule.length} 个）`}`}
              size="small"
              loading={moduleLoading}
              styles={{ body: { padding: 0 } }}
            >
              <Table<CaseFile>
                rowKey="id"
                size="small"
                dataSource={filesOfSelectedModule}
                pagination={{ pageSize: 15, hideOnSinglePage: true }}
                locale={{
                  emptyText:
                    selectedModule === undefined
                      ? '没有 feature 文件'
                      : `模块 ${selectedModule} 下没有 feature 文件`,
                }}
                columns={[
                  {
                    title: '文件',
                    dataIndex: 'path',
                    render: (path: string, file) => (
                      <div>
                        <code className="break-all text-xs">{path}</code>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Tag>{fileModuleOf(file)}</Tag>
                          <span className="text-xs text-gh-muted">{file.scenarioCount} 场景</span>
                          <StatusBadge
                            status={file.parseStatus === 'parsed' ? 'active' : file.parseStatus}
                          />
                          {file.missing === true && <Tag color="default">仓库已不存在</Tag>}
                        </div>
                      </div>
                    ),
                  },
                  {
                    title: '操作',
                    key: 'ops',
                    width: 220,
                    render: (_value, file) => (
                      <Space size={4} wrap>
                        <Button
                          size="small"
                          icon={<FileEdit size={13} />}
                          disabled={file.missing === true}
                          title={file.missing === true ? '文件已不在仓库中，无法编辑' : undefined}
                          onClick={() => {
                            guardDirty(() => {
                              void openEditor(file.path);
                            });
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          size="small"
                          disabled={file.missing === true}
                          onClick={() => {
                            setMoveTarget({
                              path: file.path,
                              module: fileModuleOf(file),
                            });
                          }}
                        >
                          改模块
                        </Button>
                      </Space>
                    ),
                  },
                ]}
              />
            </Card>

            <Card title={`场景（${filtered.length}）`} size="small" styles={{ body: { padding: 0 } }}>
              <Table<CaseItem>
                rowKey="id"
                size="small"
                dataSource={filtered}
                pagination={{ pageSize: 20, hideOnSinglePage: true }}
                onRow={(record) => ({
                  onClick: () => {
                    guardDirty(() => {
                      openCaseEditor(record.featurePath);
                    });
                  },
                  className: 'cursor-pointer',
                })}
                columns={[
                  {
                    title: '场景',
                    dataIndex: 'name',
                    render: (name: string, item) => (
                      <div>
                        <span className="text-sm font-medium">{name}</span>
                        <div className="text-xs text-gh-muted">
                          <code>
                            {item.featurePath}:{item.line}
                          </code>
                        </div>
                      </div>
                    ),
                  },
                  {
                    title: 'Case Key',
                    dataIndex: 'caseKey',
                    render: (value: string) => <code className="text-xs">{value}</code>,
                  },
                  {
                    title: '模块',
                    dataIndex: 'moduleKey',
                    render: (value: string) => <Tag>{value}</Tag>,
                  },
                  {
                    title: 'Layer',
                    dataIndex: 'tags',
                    render: (tags: string[]) => {
                      const layer = tags.find((tag) => tag.startsWith('layer:'));

                      return layer === undefined ? '-' : <Tag>{layer.slice(6)}</Tag>;
                    },
                  },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    render: (status: string) => <StatusBadge status={status} />,
                  },
                ]}
              />
            </Card>
          </div>
        </div>
      )}

      {/* 在线编辑器：左右分栏，左编辑、右预览 + step 快捷输入 */}
      <Modal
        open={editor !== null}
        title={editor?.path}
        width={1180}
        okText="保存"
        cancelText="关闭"
        onCancel={() => {
          guardDirty(() => setEditor(null));
        }}
        onOk={() => {
          void saveEditor();
        }}
        confirmLoading={saving}
        okButtonProps={{ icon: <Save size={14} />, disabled: editor === null || !editor.dirty }}
        destroyOnHidden
      >
        {editor !== null && (
          <div className="space-y-2">
            {editor.detail?.parseStatus === 'invalid' && (
              <Alert
                type="error"
                showIcon
                message="文件解析错误"
                description={editor.detail.parseError ?? '请检查 Gherkin 语法'}
              />
            )}
            {editor.detail?.pendingExport === true && (
              <Alert
                type="warning"
                showIcon
                message="该文件在数据库中已修改，尚未导出到仓库"
              />
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs text-gh-muted">
                  编辑 Gherkin{editor.detail?.storage === 'db' ? '（数据库存储）' : '（提交到 Git）'}
                </div>
                <StepEditor
                  value={editor.content}
                  onChange={(content) => setEditor({ ...editor, content, dirty: true })}
                  suggestions={suggestions}
                  rows={22}
                />
              </div>
              <div className="space-y-2">
                <div className="text-xs text-gh-muted">预览（前 400 行）</div>
                <TerminalSteps lines={preview ?? []} />
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* 改模块归属 */}
      <Modal
        open={moveTarget !== null}
        title="修改所属模块"
        okText="移动"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => setMoveTarget(null)}
        onOk={() => {
          void submitMove();
        }}
        destroyOnHidden
      >
        <p className="text-xs text-gh-muted">
          将重写 <code>{moveTarget?.path}</code> 内全部场景的 <code>@module</code> 标签。
        </p>
        <Select
          showSearch
          className="w-full"
          placeholder="选择目标模块"
          value={moveTarget?.module ?? null}
          options={modules.map((module) => ({ value: module, label: module }))}
          onChange={(value: string) => {
            setMoveTarget((previous) =>
              previous === null ? previous : { path: previous.path, module: value },
            );
          }}
        />
      </Modal>

      {/* 模块增 / 改 / 删 */}
      <Modal
        open={moduleAction !== null}
        title={
          moduleAction?.type === 'add'
            ? '新建模块'
            : moduleAction?.type === 'rename'
              ? '重命名模块'
              : '删除模块'
        }
        okText={moduleAction?.type === 'delete' ? '执行删除' : '确定'}
        okButtonProps={{ danger: moduleAction?.type === 'delete' }}
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => {
          setModuleAction(null);
          moduleForm.resetFields();
        }}
        onOk={() => {
          void submitModuleAction();
        }}
        destroyOnHidden
      >
        <Form form={moduleForm} layout="vertical" requiredMark={false}>
          {moduleAction?.type === 'add' && (
            <Form.Item label="父模块（可选）">
              <Input value={moduleAction.parent} disabled />
            </Form.Item>
          )}
          {moduleAction?.type !== 'delete' && (
            <Form.Item
              name="key"
              label="模块 key"
              rules={[
                { required: true, message: '请输入模块 key' },
                { pattern: MODULE_KEY_PATTERN, message: '只允许字母、数字、_ . -' },
              ]}
              tooltip="支持层级，例如 posts.comments；会写入 @module 标签"
            >
              <Input placeholder="posts.comments" />
            </Form.Item>
          )}
          {moduleAction?.type === 'delete' && (
            <>
              <Alert
                type="warning"
                showIcon
                className="mb-3"
                message={`即将删除模块 ${moduleAction.key} 及其子模块的用例归属`}
              />
              <Form.Item name="deleteCases" label="处理方式">
                <Radio.Group>
                  <Radio value={false}>改为 unknown（保留用例）</Radio>
                  <Radio value={true}>连同用例一并删除</Radio>
                </Radio.Group>
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}
