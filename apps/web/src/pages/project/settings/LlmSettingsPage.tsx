// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
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
import { Pencil, Plus, Sparkles, Trash2, Zap } from 'lucide-react';
import { api, ApiError } from '../../../api/client';
import type { Credential, LlmProfile } from '../../../api/types';
import EmptyState from '../../../components/EmptyState';
import ErrorState from '../../../components/ErrorState';
import LoadingSkeleton from '../../../components/LoadingSkeleton';
import PageHeader from '../../../components/PageHeader';
import StatusBadge from '../../../components/StatusBadge';
import { useProject } from '../../../components/ProjectLayout';
import { useAsync } from '../../../hooks/useAsync';

interface LlmFormValues {
  name: string;
  purpose: 'generation' | 'triage' | 'docs' | 'vision';
  provider: 'openai-compatible' | 'anthropic' | 'gemini' | 'deepseek';
  baseUrl: string;
  model: string;
  credentialId?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  enabled: boolean;
}

export default function LlmSettingsPage() {
  const { project } = useProject();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<LlmFormValues>();
  const [openModal, setOpenModal] = useState(false);
  const [editing, setEditing] = useState<LlmProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data, loading, error, reload } = useAsync(
    () => Promise.all([api.listLlmProfiles(project.id), api.listCredentials(project.id)]),
    [project.id],
  );
  const profiles = data?.[0] ?? [];
  const llmCredentials: Credential[] = (data?.[1] ?? []).filter(
    (credential) => credential.type === 'llm_api_key',
  );

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      purpose: 'generation',
      provider: 'openai-compatible',
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
    });
    setOpenModal(true);
  };

  const openEdit = (profile: LlmProfile): void => {
    setEditing(profile);
    form.setFieldsValue({
      name: profile.name,
      purpose: profile.purpose,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      credentialId: profile.credentialId ?? undefined,
      temperature:
        typeof profile.params.temperature === 'number' ? profile.params.temperature : undefined,
      maxTokens:
        typeof profile.params.maxTokens === 'number' ? profile.params.maxTokens : undefined,
      enabled: profile.enabled,
    });
    setOpenModal(true);
  };

  const save = async (values: LlmFormValues): Promise<void> => {
    setSaving(true);
    const params = {
      ...(values.temperature === undefined ? {} : { temperature: values.temperature }),
      ...(values.maxTokens === undefined ? {} : { maxTokens: values.maxTokens }),
    };

    try {
      if (editing === null) {
        await api.createLlmProfile(project.id, {
          name: values.name,
          purpose: values.purpose,
          provider: values.provider,
          baseUrl: values.baseUrl,
          model: values.model,
          credentialId: values.credentialId ?? null,
          params,
          enabled: values.enabled,
        });
        message.success('LLM Profile 已创建');
      } else {
        await api.updateLlmProfile(editing.id, {
          name: values.name,
          purpose: values.purpose,
          provider: values.provider,
          baseUrl: values.baseUrl,
          model: values.model,
          ...(values.credentialId === undefined
            ? { credentialId: null }
            : { credentialId: values.credentialId }),
          params,
          enabled: values.enabled,
        });
        message.success('LLM Profile 已更新');
      }

      setOpenModal(false);
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const test = async (profile: LlmProfile): Promise<void> => {
    setBusyId(profile.id);

    try {
      const result = await api.testLlmProfile(profile.id);

      if (result.status === 'ok') {
        message.success(result.message || 'LLM 连接成功');
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

  const remove = async (profile: LlmProfile): Promise<void> => {
    setBusyId(profile.id);

    try {
      await api.deleteLlmProfile(profile.id);
      message.success('LLM Profile 已删除');
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
        title="LLM Profile"
        description="generation 用于生成，triage 用于失败归因；未配置 triage 时只走规则"
        actions={
          <Button type="primary" icon={<Plus size={15} />} onClick={openCreate}>
            新建 Profile
          </Button>
        }
      />

      {loading && data === undefined && <LoadingSkeleton />}
      {error !== undefined && <ErrorState error={error} onRetry={reload} />}

      <Card styles={{ body: { padding: 0 } }}>
        {data !== undefined && profiles.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={40} className="mx-auto text-gh-muted" />}
            title="还没有 LLM Profile"
            description="生成用例至少需要一个启用的 generation Profile。"
            action={
              <Button type="primary" onClick={openCreate}>
                新建 Profile
              </Button>
            }
          />
        ) : (
          <Table<LlmProfile>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={profiles}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (name: string, profile) => (
                  <div>
                    <span className="text-sm font-medium">{name}</span>
                    <div className="text-xs text-gh-muted">{profile.model}</div>
                  </div>
                ),
              },
              {
                title: '用途',
                dataIndex: 'purpose',
                render: (purpose: string) => <Tag color="purple">{purpose}</Tag>,
              },
              {
                title: '提供商',
                dataIndex: 'provider',
                render: (provider: string) => <Tag>{provider}</Tag>,
              },
              {
                title: '启用',
                dataIndex: 'enabled',
                render: (enabled: boolean) => (
                  <StatusBadge status={enabled ? 'active' : 'skipped'} />
                ),
              },
              {
                title: '健康',
                dataIndex: 'healthStatus',
                render: (status: string) => <StatusBadge status={status} />,
              },
              {
                title: '操作',
                width: 260,
                render: (_value, profile) => (
                  <div className="flex gap-2">
                    <Button
                      size="small"
                      icon={<Zap size={13} />}
                      loading={busyId === profile.id}
                      onClick={() => void test(profile)}
                    >
                      测试
                    </Button>
                    <Button
                      size="small"
                      icon={<Pencil size={13} />}
                      onClick={() => openEdit(profile)}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除 LLM Profile"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void remove(profile)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<Trash2 size={13} />}
                        loading={busyId === profile.id}
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
        title={editing === null ? '新建 LLM Profile' : '编辑 LLM Profile'}
        okText="保存"
        cancelText="取消"
        width={640}
        confirmLoading={saving}
        onCancel={() => setOpenModal(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<LlmFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            void save(values);
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Form.Item name="name" label="名称" rules={[{ required: true }]}>
              <Input placeholder="DeepSeek 生成" />
            </Form.Item>
            <Form.Item name="purpose" label="用途" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'generation', label: 'generation' },
                  { value: 'triage', label: 'triage' },
                  { value: 'docs', label: 'docs' },
                  { value: 'vision', label: 'vision' },
                ]}
              />
            </Form.Item>
            <Form.Item name="provider" label="提供商" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'openai-compatible', label: 'OpenAI Compatible' },
                  { value: 'anthropic', label: 'Anthropic' },
                  { value: 'gemini', label: 'Gemini' },
                  { value: 'deepseek', label: 'DeepSeek' },
                ]}
              />
            </Form.Item>
            <Form.Item name="model" label="模型" rules={[{ required: true }]}>
              <Input placeholder="deepseek-chat" />
            </Form.Item>
            <Form.Item
              name="baseUrl"
              label="Base URL"
              rules={[{ required: true }, { type: 'url' }]}
              className="md:col-span-2"
            >
              <Input placeholder="https://api.deepseek.com/v1" />
            </Form.Item>
            <Form.Item name="credentialId" label="API Key 凭据">
              <Select
                allowClear
                placeholder={
                  llmCredentials.length === 0 ? '请先在 Git 页创建 LLM 凭据' : '选择凭据'
                }
                options={llmCredentials.map((credential) => ({
                  value: credential.id,
                  label: `${credential.name} (${credential.maskedSecret})`,
                }))}
              />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="temperature" label="Temperature">
              <InputNumber min={0} max={2} step={0.1} className="w-full" />
            </Form.Item>
            <Form.Item name="maxTokens" label="Max Tokens">
              <InputNumber min={1} max={1_000_000} className="w-full" />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
