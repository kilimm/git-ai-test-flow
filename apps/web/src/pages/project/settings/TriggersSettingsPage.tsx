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
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { KeyRound, Plus, RefreshCw, Trash2, Webhook } from 'lucide-react';
import { PERMISSION } from '@gait/shared';
import { api, ApiError } from '../../../api/client';
import type { TriggerConfig } from '../../../api/types';
import ErrorState from '../../../components/ErrorState';
import LoadingSkeleton from '../../../components/LoadingSkeleton';
import PageHeader from '../../../components/PageHeader';
import PermissionGate from '../../../components/PermissionGate';
import { useProject } from '../../../components/ProjectLayout';
import { useAsync } from '../../../hooks/useAsync';

interface TriggerFormValues {
  name: string;
  type: 'schedule' | 'git_webhook' | 'deployment';
  action: 'generate' | 'run';
  cron?: string;
  branch?: string;
  environmentId?: string;
  selectionType: 'all' | 'modules' | 'cases' | 'impact';
  modules?: string;
  caseKeys?: string;
}

const { Paragraph, Text } = Typography;

export default function TriggersSettingsPage() {
  const { project } = useProject();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<TriggerFormValues>();
  const [openModal, setOpenModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tokenModal, setTokenModal] = useState<{ name: string; token: string } | null>(null);
  const type = Form.useWatch('type', form);
  const selectionType = Form.useWatch('selectionType', form);
  const { data, loading, error, reload } = useAsync(
    () => Promise.all([api.listTriggers(project.id), api.listEnvironments(project.id)]),
    [project.id],
  );
  const triggers = data?.[0] ?? [];
  const environments = data?.[1] ?? [];

  const create = async (values: TriggerFormValues): Promise<void> => {
    setSaving(true);

    try {
      const modules = (values.modules ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const caseKeys = (values.caseKeys ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const result = await api.createTrigger(project.id, {
        name: values.name,
        type: values.type,
        action: values.action,
        ...(values.cron === undefined ? {} : { cron: values.cron }),
        ...(values.branch === undefined ? {} : { branch: values.branch }),
        ...(values.environmentId === undefined ? {} : { environmentId: values.environmentId }),
        selection: {
          type: values.selectionType,
          ...(values.selectionType === 'modules' ? { modules } : {}),
          ...(values.selectionType === 'cases' ? { caseKeys } : {}),
        },
      });

      if (result.token !== null) {
        setTokenModal({ name: result.trigger.name, token: result.token });
      }

      message.success('触发器已创建');
      setOpenModal(false);
      form.resetFields();
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '创建触发器失败');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (trigger: TriggerConfig, enabled: boolean): Promise<void> => {
    try {
      await api.updateTrigger(project.id, trigger.id, { enabled });
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '更新触发器失败');
    }
  };

  const rotate = async (trigger: TriggerConfig): Promise<void> => {
    try {
      const result = await api.updateTrigger(project.id, trigger.id, { rotateToken: true });

      if (result.token !== null) {
        setTokenModal({ name: trigger.name, token: result.token });
      }

      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '轮换 token 失败');
    }
  };

  const remove = async (trigger: TriggerConfig): Promise<void> => {
    try {
      await api.deleteTrigger(project.id, trigger.id);
      message.success('触发器已删除');
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '删除触发器失败');
    }
  };

  if (loading && data === undefined) {
    return <LoadingSkeleton />;
  }

  if (error !== undefined) {
    return <ErrorState error={error} onRetry={reload} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="触发器"
        description="Webhook 与部署回调只负责按 token 触发新 Run/Generation；平台不执行产品部署"
        actions={
          <Space>
            <Button icon={<RefreshCw size={15} />} onClick={reload}>
              刷新
            </Button>
            <PermissionGate permission={PERMISSION.PROJECT_UPDATE}>
              <Button type="primary" icon={<Plus size={15} />} onClick={() => setOpenModal(true)}>
                新建触发器
              </Button>
            </PermissionGate>
          </Space>
        }
      />

      <Alert
        type="info"
        showIcon
        message="Webhook 地址"
        description={
          <div className="space-y-1 text-xs">
            <div>
              Git：<code>{`${window.location.origin}/webhooks/git/${project.id}`}</code>
            </div>
            <div>
              部署回调：<code>{`${window.location.origin}/webhooks/deploy/${project.id}`}</code>
            </div>
            <div>
              请求头：`Authorization: Bearer &lt;token&gt;` 或 `X-Gait-Token: &lt;token&gt;`。
            </div>
          </div>
        }
      />

      <Card styles={{ body: { padding: 0 } }}>
        <Table<TriggerConfig>
          rowKey="id"
          size="small"
          dataSource={triggers}
          pagination={false}
          locale={{ emptyText: '暂无触发器' }}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (name: string, trigger) => (
                <div>
                  <div className="text-sm font-medium">{name}</div>
                  <div className="mt-1 flex gap-1">
                    <Tag>{trigger.type}</Tag>
                    <Tag color={trigger.action === 'run' ? 'blue' : 'purple'}>{trigger.action}</Tag>
                  </div>
                </div>
              ),
            },
            {
              title: '条件',
              render: (_value, trigger) => (
                <div className="text-xs">
                  {trigger.type === 'schedule' && <div>Cron: {trigger.cron}</div>}
                  {trigger.type !== 'schedule' && (
                    <div>{trigger.type === 'deployment' ? '部署回调' : 'Git 推送'} token</div>
                  )}
                  <div className="text-gh-muted">
                    选择：{trigger.selection.type}
                    {trigger.selection.modules.length > 0
                      ? ` / ${trigger.selection.modules.join(', ')}`
                      : ''}
                  </div>
                  {trigger.nextRunAt !== null && (
                    <div className="text-gh-muted">
                      下次：{new Date(trigger.nextRunAt).toLocaleString('zh-CN')}
                    </div>
                  )}
                </div>
              ),
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              render: (enabled: boolean, trigger) => (
                <Switch
                  size="small"
                  checked={enabled}
                  onChange={(checked) => void toggle(trigger, checked)}
                />
              ),
            },
            {
              title: '最近触发',
              dataIndex: 'lastFiredAt',
              render: (value: string | null) =>
                value === null ? '-' : new Date(value).toLocaleString('zh-CN'),
            },
            {
              title: '',
              width: 140,
              render: (_value, trigger) => (
                <Space>
                  {trigger.type !== 'schedule' && (
                    <Button
                      size="small"
                      icon={<KeyRound size={13} />}
                      onClick={() => void rotate(trigger)}
                    >
                      轮换
                    </Button>
                  )}
                  <Popconfirm
                    title="删除触发器"
                    description="删除后对应 token 立即失效。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void remove(trigger)}
                  >
                    <Button danger size="small" icon={<Trash2 size={13} />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={openModal}
        title="新建触发器"
        okText="创建"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => setOpenModal(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<TriggerFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ type: 'deployment', action: 'run', selectionType: 'all' }}
          onFinish={(values) => void create(values)}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="deploy callback" />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'deployment', label: '部署回调（推荐）' },
                { value: 'git_webhook', label: 'Git Webhook' },
                { value: 'schedule', label: '定时任务' },
              ]}
            />
          </Form.Item>
          <Form.Item name="action" label="动作" rules={[{ required: true }]}>
            <Radio.Group
              disabled={type === 'deployment'}
              options={[
                { value: 'run', label: '直接创建 Run' },
                { value: 'generate', label: '创建生成任务' },
              ]}
            />
          </Form.Item>
          {type === 'schedule' && (
            <Form.Item
              name="cron"
              label="Cron（UTC，5 段）"
              rules={[{ required: true }]}
              extra="例如 0 2 * * * 表示每天 02:00 UTC"
            >
              <Input placeholder="0 2 * * *" className="font-mono" />
            </Form.Item>
          )}
          <Form.Item name="environmentId" label="环境（可选，默认使用默认环境）">
            <Select
              allowClear
              options={environments.map((environment) => ({
                value: environment.id,
                label: `${environment.name}${environment.isDefault ? '（默认）' : ''}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="selectionType" label="用例选择">
            <Radio.Group
              options={[
                { value: 'all', label: '全部' },
                { value: 'impact', label: '影响面' },
                { value: 'modules', label: '按模块' },
                { value: 'cases', label: '按 caseKey' },
              ]}
            />
          </Form.Item>
          {selectionType === 'modules' && (
            <Form.Item name="modules" label="模块（逗号分隔）" rules={[{ required: true }]}>
              <Input placeholder="posts, auth" />
            </Form.Item>
          )}
          {selectionType === 'cases' && (
            <Form.Item name="caseKeys" label="Case Key（逗号分隔）" rules={[{ required: true }]}>
              <Input placeholder="POST-API-001" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        open={tokenModal !== null}
        title="触发器 token"
        footer={
          <Button type="primary" onClick={() => setTokenModal(null)}>
            我已保存
          </Button>
        }
        onCancel={() => setTokenModal(null)}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          className="mb-3"
          message="token 只显示一次，平台只保存 SHA-256"
        />
        <Paragraph copyable={{ text: tokenModal?.token ?? '' }}>
          <Text code>{tokenModal?.token}</Text>
        </Paragraph>
        <div className="text-xs text-gh-muted">
          用于 {tokenModal?.name}。在外部 CI/CD 的部署完成后调用部署回调并携带该 token。
        </div>
        <Webhook className="mt-3 text-gh-muted" size={18} />
      </Modal>
    </div>
  );
}
