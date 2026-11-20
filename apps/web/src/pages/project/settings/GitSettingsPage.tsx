// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Table,
  Tag,
} from 'antd';
import { Cable, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../../api/client';
import type { Credential, TestResult } from '../../../api/types';
import EmptyState from '../../../components/EmptyState';
import ErrorState from '../../../components/ErrorState';
import LoadingSkeleton from '../../../components/LoadingSkeleton';
import PageHeader from '../../../components/PageHeader';
import { useProject } from '../../../components/ProjectLayout';
import { useAsync } from '../../../hooks/useAsync';

interface CredentialFormValues {
  name: string;
  type: 'git_pat' | 'llm_api_key' | 'test_account' | 'db_password';
  username?: string | undefined;
  secret?: string | undefined;
}

export default function GitSettingsPage() {
  const { project } = useProject();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CredentialFormValues>();
  const [openModal, setOpenModal] = useState(false);
  const [editing, setEditing] = useState<Credential | null>(null);
  const [saving, setSaving] = useState(false);
  const [connection, setConnection] = useState<TestResult | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data, loading, error, reload } = useAsync(
    () => api.listCredentials(project.id),
    [project.id],
  );

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ type: 'git_pat' });
    setOpenModal(true);
  };

  const openEdit = (credential: Credential): void => {
    setEditing(credential);
    form.setFieldsValue({
      name: credential.name,
      type: credential.type as CredentialFormValues['type'],
      username: credential.username ?? undefined,
    });
    setOpenModal(true);
  };

  const save = async (values: CredentialFormValues): Promise<void> => {
    setSaving(true);

    try {
      if (editing === null) {
        await api.createCredential(project.id, {
          name: values.name,
          type: values.type,
          username: values.username ?? null,
          secret: values.secret ?? '',
        });
        message.success('凭据已创建');
      } else {
        await api.updateCredential(editing.id, {
          name: values.name,
          ...(values.username === undefined ? {} : { username: values.username }),
          ...(values.secret === undefined || values.secret.length === 0
            ? {}
            : { secret: values.secret }),
        });
        message.success('Git 凭据已更新');
      }

      setOpenModal(false);
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '保存凭据失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (credential: Credential): Promise<void> => {
    setBusyId(credential.id);

    try {
      await api.deleteCredential(credential.id);
      message.success('凭据已删除');
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  const test = async (credential: Credential): Promise<void> => {
    setBusyId(credential.id);

    try {
      const result = await api.testCredential(credential.id);

      if (result.status === 'ok') {
        message.success(result.message || '凭据可用');
      } else {
        message.error(`${result.code}: ${result.message}`);
      }
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '测试失败');
    } finally {
      setBusyId(null);
    }
  };

  const testProject = async (): Promise<void> => {
    setTestingConnection(true);

    try {
      setConnection(await api.testProjectConnection(project.id));
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '测试连接失败');
    } finally {
      setTestingConnection(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="凭据"
        description="Git / LLM / 数据库 / 测试账号凭据密文存储，API 只返回掩码"
        actions={
          <>
            <Button
              loading={testingConnection}
              icon={<Cable size={15} />}
              onClick={() => void testProject()}
            >
              测试项目连接
            </Button>
            <Button type="primary" icon={<Plus size={15} />} onClick={openCreate}>
              新建凭据
            </Button>
          </>
        }
      />

      {connection !== null && (
        <Alert
          type={connection.status === 'ok' ? 'success' : 'error'}
          showIcon
          closable
          message={connection.status === 'ok' ? '仓库连接成功' : '仓库连接失败'}
          description={`${connection.code}: ${connection.message}（${connection.durationMs ?? 0}ms）`}
          onClose={() => setConnection(null)}
        />
      )}

      {loading && data === undefined && <LoadingSkeleton />}
      {error !== undefined && <ErrorState error={error} onRetry={reload} />}

      <Card styles={{ body: { padding: 0 } }}>
        {data !== undefined && data.length === 0 ? (
          <EmptyState
            title="还没有 Git 凭据"
            description="Private 仓库需要 PAT；公开仓库也可不配置凭据。"
            action={
              <Button type="primary" onClick={openCreate}>
                新建凭据
              </Button>
            }
          />
        ) : (
          <Table<Credential>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={data ?? []}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (name: string, credential: Credential) => (
                  <div>
                    <span className="text-sm font-medium text-gh-text">{name}</span>
                    <div className="text-xs text-gh-muted">{credential.username ?? '无用户名'}</div>
                  </div>
                ),
              },
              {
                title: '类型',
                dataIndex: 'type',
                render: (type: string) => <Tag>{type}</Tag>,
              },
              {
                title: '密钥',
                dataIndex: 'maskedSecret',
                render: (value: string) => <code className="font-mono text-xs">{value}</code>,
              },
              {
                title: '操作',
                width: 260,
                render: (_value, credential) => (
                  <div className="flex gap-2">
                    <Button
                      size="small"
                      loading={busyId === credential.id}
                      onClick={() => void test(credential)}
                    >
                      测试
                    </Button>
                    <Button
                      size="small"
                      icon={<Pencil size={13} />}
                      onClick={() => openEdit(credential)}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除凭据"
                      description="被项目或环境引用的凭据无法删除。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void remove(credential)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<Trash2 size={13} />}
                        loading={busyId === credential.id}
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
        title={editing === null ? '新建凭据' : '编辑凭据'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => setOpenModal(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<CredentialFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            void save(values);
          }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="GitHub PAT" />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select
              disabled={editing !== null}
              options={[
                { value: 'git_pat', label: 'Git PAT' },
                { value: 'llm_api_key', label: 'LLM API Key' },
                { value: 'test_account', label: '测试账号' },
                { value: 'db_password', label: '数据库密码' },
              ]}
            />
          </Form.Item>
          <Form.Item name="username" label="用户名（可选）">
            <Input placeholder="git" />
          </Form.Item>
          <Form.Item
            name="secret"
            label={editing === null ? 'PAT / Token' : 'PAT / Token（留空不修改）'}
            rules={editing === null ? [{ required: true }] : []}
          >
            <Input.Password autoComplete="new-password" placeholder="ghp_xxx" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
