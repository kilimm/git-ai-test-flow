// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Table,
  Tag,
} from 'antd';
import { Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { api, ApiError } from '../../../api/client';
import type { EnvironmentInput } from '../../../api/client';
import type { EnvironmentProfile } from '../../../api/types';
import EmptyState from '../../../components/EmptyState';
import ErrorState from '../../../components/ErrorState';
import LoadingSkeleton from '../../../components/LoadingSkeleton';
import PageHeader from '../../../components/PageHeader';
import StatusBadge from '../../../components/StatusBadge';
import { useProject } from '../../../components/ProjectLayout';
import { useAsync } from '../../../hooks/useAsync';

interface EnvironmentFormValues {
  name: string;
  apiBaseUrl: string;
  webBaseUrl?: string | undefined;
  healthcheckUrl?: string | undefined;
  healthcheckExpectedStatus: number;
  healthcheckTimeoutMs: number;
  versionSource: 'manual' | 'header' | 'endpoint';
  versionHeader?: string | undefined;
  versionEndpoint?: string | undefined;
  versionJsonPath?: string | undefined;
  deployedSha?: string | undefined;
  strictVersionMatch: boolean;
  dbEnabled: boolean;
  dbType: 'sqlite' | 'mysql' | 'postgresql';
  dbHost?: string | undefined;
  dbPort?: number | undefined;
  dbName?: string | undefined;
  dbSchema?: string | undefined;
  dbUser?: string | undefined;
  dbCredentialId?: string | undefined;
  testAccountCredentialId?: string | undefined;
  dbIsTest: boolean;
  dbWriteMode: 'readonly' | 'fixtures' | 'full';
  confirmDangerous: boolean;
  caseTimeoutMs: number;
  apiConcurrency: number;
  uiConcurrency: number;
  isDefault: boolean;
}

function initialValues(environment: EnvironmentProfile | null): EnvironmentFormValues {
  return {
    name: environment?.name ?? '',
    apiBaseUrl: environment?.apiBaseUrl ?? '',
    webBaseUrl: environment?.webBaseUrl ?? undefined,
    healthcheckUrl: environment?.healthcheck?.url ?? undefined,
    healthcheckExpectedStatus: environment?.healthcheck?.expectedStatus ?? 200,
    healthcheckTimeoutMs: environment?.healthcheck?.timeoutMs ?? 10_000,
    versionSource: environment?.version.source ?? 'manual',
    versionHeader: environment?.version.header ?? undefined,
    versionEndpoint: environment?.version.endpoint ?? undefined,
    versionJsonPath: environment?.version.jsonPath ?? undefined,
    deployedSha: environment?.version.deployedSha ?? undefined,
    strictVersionMatch: environment?.version.strictVersionMatch ?? false,
    dbEnabled: environment?.db !== null && environment?.db !== undefined,
    dbType: environment?.db?.type ?? 'sqlite',
    dbHost: environment?.db?.host ?? undefined,
    dbPort: environment?.db?.port ?? undefined,
    dbName: environment?.db?.name ?? '',
    dbSchema: environment?.db?.schema ?? undefined,
    dbUser: environment?.db?.user ?? undefined,
    dbCredentialId: environment?.db?.credentialId ?? undefined,
    testAccountCredentialId: environment?.testAccountCredentialId ?? undefined,
    dbIsTest: environment?.db?.isTest ?? true,
    dbWriteMode: environment?.db?.writeMode ?? 'readonly',
    confirmDangerous: false,
    caseTimeoutMs: environment?.caseTimeoutMs ?? 60_000,
    apiConcurrency: environment?.apiConcurrency ?? 3,
    uiConcurrency: environment?.uiConcurrency ?? 1,
    isDefault: environment?.isDefault ?? false,
  };
}

export default function EnvironmentsSettingsPage() {
  const { project } = useProject();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<EnvironmentFormValues>();
  const [openModal, setOpenModal] = useState(false);
  const [editing, setEditing] = useState<EnvironmentProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data, loading, error, reload } = useAsync(
    () => Promise.all([api.listEnvironments(project.id), api.listCredentials(project.id)]),
    [project.id],
  );
  const environments = data?.[0] ?? [];
  const credentials = data?.[1] ?? [];
  const dbCredentials = credentials.filter((item) => item.type === 'db_password');
  const testAccounts = credentials.filter((item) => item.type === 'test_account');
  const dbEnabled = Form.useWatch('dbEnabled', form);
  const dbType = Form.useWatch('dbType', form);
  const versionSource = Form.useWatch('versionSource', form);
  const dbWriteMode = Form.useWatch('dbWriteMode', form);
  const dbIsTest = Form.useWatch('dbIsTest', form);

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue(initialValues(null));
    setOpenModal(true);
  };

  const openEdit = (environment: EnvironmentProfile): void => {
    setEditing(environment);
    form.setFieldsValue(initialValues(environment));
    setOpenModal(true);
  };

  const save = async (values: EnvironmentFormValues): Promise<void> => {
    setSaving(true);

    try {
      const input: EnvironmentInput = {
        name: values.name,
        apiBaseUrl: values.apiBaseUrl,
        webBaseUrl: values.webBaseUrl ?? null,
        healthcheck:
          values.healthcheckUrl === undefined || values.healthcheckUrl.length === 0
            ? null
            : {
                url: values.healthcheckUrl,
                expectedStatus: values.healthcheckExpectedStatus,
                timeoutMs: values.healthcheckTimeoutMs,
              },
        version: {
          source: values.versionSource,
          strictVersionMatch: values.strictVersionMatch,
          ...(values.versionSource === 'header' && values.versionHeader !== undefined
            ? { header: values.versionHeader }
            : {}),
          ...(values.versionSource === 'endpoint' && values.versionEndpoint !== undefined
            ? { endpoint: values.versionEndpoint }
            : {}),
          ...(values.versionSource === 'endpoint' && values.versionJsonPath !== undefined
            ? { jsonPath: values.versionJsonPath }
            : {}),
          ...(values.deployedSha === undefined ? {} : { deployedSha: values.deployedSha }),
        },
        db: values.dbEnabled
          ? {
              type: values.dbType,
              host: values.dbType === 'sqlite' ? null : (values.dbHost ?? null),
              port: values.dbType === 'sqlite' ? null : (values.dbPort ?? null),
              name: values.dbName ?? '',
              schema: values.dbType === 'postgresql' ? (values.dbSchema ?? null) : null,
              user: values.dbUser ?? null,
              credentialId: values.dbCredentialId ?? null,
              ssl: false,
              isTest: values.dbIsTest,
              writeMode: values.dbIsTest ? values.dbWriteMode : 'readonly',
            }
          : null,
        testAccountCredentialId: values.testAccountCredentialId ?? null,
        caseTimeoutMs: values.caseTimeoutMs,
        apiConcurrency: values.apiConcurrency,
        uiConcurrency: values.uiConcurrency,
        isDefault: values.isDefault,
        ...(values.dbWriteMode === 'readonly' || !values.dbIsTest
          ? {}
          : { confirmDangerous: values.confirmDangerous }),
      };

      if (editing === null) {
        await api.createEnvironment(project.id, input);
        message.success('环境已创建');
      } else {
        await api.updateEnvironment(editing.id, input);
        message.success('环境已更新');
      }

      setOpenModal(false);
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '保存环境失败');
    } finally {
      setSaving(false);
    }
  };

  const test = async (environment: EnvironmentProfile): Promise<void> => {
    setBusyId(environment.id);

    try {
      const result = await api.testEnvironment(environment.id);

      if (result.status === 'ok') {
        message.success(result.message || '环境可用');
      } else {
        message.error(`${result.code}: ${result.message}`);
      }

      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '测试失败');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (environment: EnvironmentProfile): Promise<void> => {
    setBusyId(environment.id);

    try {
      await api.deleteEnvironment(environment.id);
      message.success('环境已删除');
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="测试环境"
        description="平台只访问已部署环境，不构建/部署产品代码"
        actions={
          <Button type="primary" icon={<Plus size={15} />} onClick={openCreate}>
            新建环境
          </Button>
        }
      />

      {loading && data === undefined && <LoadingSkeleton />}
      {error !== undefined && <ErrorState error={error} onRetry={reload} />}

      <Card styles={{ body: { padding: 0 } }}>
        {data !== undefined && environments.length === 0 ? (
          <EmptyState
            title="还没有环境"
            description="至少配置一个默认环境，Run 才能执行。"
            action={
              <Button type="primary" onClick={openCreate}>
                新建环境
              </Button>
            }
          />
        ) : (
          <Table<EnvironmentProfile>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={environments}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (name: string, environment) => (
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium">{name}</span>
                      {environment.isDefault && <Tag color="blue">默认</Tag>}
                    </div>
                    <code className="text-xs text-gh-muted">{environment.apiBaseUrl}</code>
                  </div>
                ),
              },
              {
                title: '版本来源',
                dataIndex: 'version',
                render: (version: EnvironmentProfile['version']) => (
                  <div className="text-xs">
                    <Tag>{version.source}</Tag>
                    {version.strictVersionMatch && <Tag color="gold">严格比对</Tag>}
                    {version.deployedSha !== null && (
                      <code className="font-mono">{version.deployedSha.slice(0, 8)}</code>
                    )}
                  </div>
                ),
              },
              {
                title: '健康',
                dataIndex: 'healthStatus',
                render: (status: string) => <StatusBadge status={status} />,
              },
              {
                title: 'DB',
                dataIndex: 'db',
                render: (db: EnvironmentProfile['db']) =>
                  db === null ? (
                    <span className="text-xs text-gh-muted">未配置</span>
                  ) : (
                    <Tag color={db.isTest ? 'green' : 'red'}>
                      {db.type}/{db.writeMode}
                    </Tag>
                  ),
              },
              {
                title: '操作',
                width: 260,
                render: (_value, environment) => (
                  <div className="flex gap-2">
                    <Button
                      size="small"
                      icon={<Zap size={13} />}
                      loading={busyId === environment.id}
                      onClick={() => void test(environment)}
                    >
                      测试
                    </Button>
                    <Button
                      size="small"
                      icon={<Pencil size={13} />}
                      onClick={() => openEdit(environment)}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除环境"
                      description="运行历史仍保留，但不能再创建新 Run。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void remove(environment)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<Trash2 size={13} />}
                        loading={busyId === environment.id}
                      >
                        删除
                      </Button>
                    </Popconfirm>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Modal
        open={openModal}
        title={editing === null ? '新建环境' : '编辑环境'}
        okText="保存"
        cancelText="取消"
        width={760}
        confirmLoading={saving}
        onCancel={() => setOpenModal(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<EnvironmentFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            void save(values);
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Form.Item name="name" label="环境名称" rules={[{ required: true }]}>
              <Input placeholder="staging" />
            </Form.Item>
            <Form.Item
              name="apiBaseUrl"
              label="API Base URL"
              rules={[{ required: true }, { type: 'url' }]}
            >
              <Input placeholder="https://staging.example.com" />
            </Form.Item>
            <Form.Item name="webBaseUrl" label="Web Base URL">
              <Input placeholder="https://staging.example.com" />
            </Form.Item>
            <Form.Item name="healthcheckUrl" label="健康检查 URL">
              <Input placeholder="https://staging.example.com/healthz" />
            </Form.Item>
            <Form.Item name="versionSource" label="版本来源">
              <Select
                options={[
                  { value: 'manual', label: 'manual（人工填写）' },
                  { value: 'header', label: 'header' },
                  { value: 'endpoint', label: 'endpoint' },
                ]}
              />
            </Form.Item>
            <Form.Item name="strictVersionMatch" label="严格版本比对" valuePropName="checked">
              <Switch />
            </Form.Item>
            {versionSource === 'header' && (
              <Form.Item name="versionHeader" label="版本响应头" rules={[{ required: true }]}>
                <Input placeholder="X-Deployed-Sha" />
              </Form.Item>
            )}
            {versionSource === 'endpoint' && (
              <>
                <Form.Item name="versionEndpoint" label="版本接口" rules={[{ required: true }]}>
                  <Input placeholder="https://staging.example.com/version" />
                </Form.Item>
                <Form.Item name="versionJsonPath" label="JSONPath" rules={[{ required: true }]}>
                  <Input placeholder="$.commit" />
                </Form.Item>
              </>
            )}
            <Form.Item name="deployedSha" label="人工版本 / 预期 SHA">
              <Input placeholder="可选" />
            </Form.Item>
            <Form.Item name="caseTimeoutMs" label="单用例超时 (ms)">
              <InputNumber min={1000} max={3_600_000} className="w-full" />
            </Form.Item>
            <Form.Item name="apiConcurrency" label="API 并发">
              <InputNumber min={1} max={64} className="w-full" />
            </Form.Item>
            <Form.Item name="uiConcurrency" label="UI 并发">
              <InputNumber min={1} max={16} className="w-full" />
            </Form.Item>
            <Form.Item name="isDefault" label="设为默认环境" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>

          <div className="mb-3 flex items-center justify-between rounded border border-gh-border p-3">
            <div>
              <div className="text-sm font-medium">数据库造数</div>
              <div className="text-xs text-gh-muted">
                生产库只读；写模式需要二次确认，且仅允许参数化 DML。
              </div>
            </div>
            <Form.Item name="dbEnabled" valuePropName="checked" noStyle>
              <Switch />
            </Form.Item>
          </div>

          {dbEnabled && (
            <div className="grid gap-3 md:grid-cols-2">
              <Form.Item name="dbType" label="数据库类型">
                <Select
                  options={[
                    { value: 'sqlite', label: 'SQLite' },
                    { value: 'mysql', label: 'MySQL' },
                    { value: 'postgresql', label: 'PostgreSQL' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="dbName" label="数据库/文件路径" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              {dbType !== 'sqlite' && (
                <>
                  <Form.Item name="dbHost" label="Host" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="dbPort" label="Port">
                    <InputNumber min={1} max={65_535} className="w-full" />
                  </Form.Item>
                  <Form.Item name="dbUser" label="User">
                    <Input />
                  </Form.Item>
                </>
              )}
              {dbType === 'postgresql' && (
                <Form.Item name="dbSchema" label="Schema">
                  <Input placeholder="public" />
                </Form.Item>
              )}
              <Form.Item name="dbIsTest" label="测试库" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="dbWriteMode" label="写模式">
                <Select
                  disabled={!dbIsTest}
                  options={[
                    { value: 'readonly', label: 'readonly' },
                    { value: 'fixtures', label: 'fixtures' },
                    { value: 'full', label: 'full' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="dbCredentialId" label="数据库密码凭据">
                <Select
                  allowClear
                  placeholder={
                    dbCredentials.length === 0 ? '请先在凭据页创建 db_password' : '选择凭据'
                  }
                  options={dbCredentials.map((credential) => ({
                    value: credential.id,
                    label: `${credential.name} (${credential.maskedSecret})`,
                  }))}
                />
              </Form.Item>
              <Form.Item name="testAccountCredentialId" label="测试账号凭据">
                <Select
                  allowClear
                  placeholder={
                    testAccounts.length === 0 ? '请先在凭据页创建 test_account' : '选择凭据'
                  }
                  options={testAccounts.map((credential) => ({
                    value: credential.id,
                    label: `${credential.name} (${credential.username ?? ''})`,
                  }))}
                />
              </Form.Item>
              {dbWriteMode !== 'readonly' && (
                <Form.Item
                  name="confirmDangerous"
                  valuePropName="checked"
                  className="md:col-span-2"
                >
                  <Checkbox>我确认该环境为测试环境，允许 fixtures 写入</Checkbox>
                </Form.Item>
              )}
            </div>
          )}
        </Form>
      </Modal>
    </div>
  );
}
