// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Switch,
  Table,
  Tag,
} from 'antd';
import { Bell, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { api, ApiError } from '../../../api/client';
import type { NotificationChannel } from '../../../api/types';
import EmptyState from '../../../components/EmptyState';
import ErrorState from '../../../components/ErrorState';
import LoadingSkeleton from '../../../components/LoadingSkeleton';
import PageHeader from '../../../components/PageHeader';
import StatusBadge from '../../../components/StatusBadge';
import { useProject } from '../../../components/ProjectLayout';
import { useAsync } from '../../../hooks/useAsync';

interface ChannelFormValues {
  name: string;
  webhookUrl?: string;
  secret?: string;
  events: string[];
  enabled: boolean;
}

const EVENT_OPTIONS = [
  { value: 'run_finished', label: '运行完成（run_finished）' },
  { value: 'run_failed', label: '运行失败（run_failed）' },
  { value: 'daily_digest', label: '每日摘要（daily_digest）' },
];

export default function NotificationsSettingsPage() {
  const { project } = useProject();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<ChannelFormValues>();
  const [openModal, setOpenModal] = useState(false);
  const [editing, setEditing] = useState<NotificationChannel | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data, loading, error, reload } = useAsync(
    () => api.listNotificationChannels(project.id),
    [project.id],
  );

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ events: ['run_finished'], enabled: true });
    setOpenModal(true);
  };

  const openEdit = (channel: NotificationChannel): void => {
    setEditing(channel);
    form.setFieldsValue({
      name: channel.name,
      events: channel.events,
      enabled: channel.enabled,
    });
    setOpenModal(true);
  };

  const save = async (values: ChannelFormValues): Promise<void> => {
    setSaving(true);

    try {
      if (editing === null) {
        await api.createNotificationChannel(project.id, {
          name: values.name,
          webhookUrl: values.webhookUrl ?? '',
          secret: values.secret ?? '',
          events: values.events,
          enabled: values.enabled,
        });
        message.success('通知渠道已创建');
      } else {
        await api.updateNotificationChannel(editing.id, {
          name: values.name,
          events: values.events,
          enabled: values.enabled,
          ...(values.webhookUrl === undefined || values.webhookUrl.length === 0
            ? {}
            : { webhookUrl: values.webhookUrl }),
          ...(values.secret === undefined || values.secret.length === 0
            ? {}
            : { secret: values.secret }),
        });
        message.success('通知渠道已更新');
      }

      setOpenModal(false);
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const test = async (channel: NotificationChannel): Promise<void> => {
    setBusyId(channel.id);

    try {
      const result = await api.testNotificationChannel(channel.id);

      if (result.status === 'ok') {
        message.success(result.message || '测试卡片已发送');
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

  const remove = async (channel: NotificationChannel): Promise<void> => {
    setBusyId(channel.id);

    try {
      await api.deleteNotificationChannel(channel.id);
      message.success('通知渠道已删除');
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
        title="飞书通知"
        description="按 Run 汇总发送，签名与去重由平台处理；Webhook/Secret 只显示掩码"
        actions={
          <Button type="primary" icon={<Plus size={15} />} onClick={openCreate}>
            新建渠道
          </Button>
        }
      />

      {loading && data === undefined && <LoadingSkeleton />}
      {error !== undefined && <ErrorState error={error} onRetry={reload} />}

      <Card styles={{ body: { padding: 0 } }}>
        {data !== undefined && data.length === 0 ? (
          <EmptyState
            icon={<Bell size={40} className="mx-auto text-gh-muted" />}
            title="还没有通知渠道"
            description="配置飞书自定义机器人 Webhook 与签名 Secret 后，Run 结束会推送摘要卡片。"
            action={
              <Button type="primary" onClick={openCreate}>
                新建渠道
              </Button>
            }
          />
        ) : (
          <Table<NotificationChannel>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={data ?? []}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (name: string, channel) => (
                  <div>
                    <span className="text-sm font-medium">{name}</span>
                    <div className="font-mono text-xs text-gh-muted">{channel.maskedWebhook}</div>
                  </div>
                ),
              },
              {
                title: '事件',
                dataIndex: 'events',
                render: (events: string[]) => (
                  <div className="flex flex-wrap gap-1">
                    {events.map((event) => (
                      <Tag key={event}>{event}</Tag>
                    ))}
                  </div>
                ),
              },
              {
                title: '启用',
                dataIndex: 'enabled',
                render: (enabled: boolean) => (
                  <StatusBadge status={enabled ? 'active' : 'skipped'} />
                ),
              },
              {
                title: '最近测试',
                dataIndex: 'lastTestStatus',
                render: (status: string, channel) => (
                  <div className="text-xs">
                    <StatusBadge status={status === 'success' ? 'passed' : status} />
                    {channel.lastTestMessage !== null && (
                      <div className="mt-1 max-w-[220px] truncate text-gh-muted">
                        {channel.lastTestMessage}
                      </div>
                    )}
                  </div>
                ),
              },
              {
                title: '操作',
                width: 260,
                render: (_value, channel) => (
                  <div className="flex gap-2">
                    <Button
                      size="small"
                      icon={<Zap size={13} />}
                      loading={busyId === channel.id}
                      onClick={() => void test(channel)}
                    >
                      测试
                    </Button>
                    <Button
                      size="small"
                      icon={<Pencil size={13} />}
                      onClick={() => openEdit(channel)}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除通知渠道"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void remove(channel)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<Trash2 size={13} />}
                        loading={busyId === channel.id}
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
        title={editing === null ? '新建飞书通知渠道' : '编辑飞书通知渠道'}
        okText="保存"
        cancelText="取消"
        width={620}
        confirmLoading={saving}
        onCancel={() => setOpenModal(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<ChannelFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            void save(values);
          }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="测试群机器人" />
          </Form.Item>
          <Form.Item
            name="webhookUrl"
            label={editing === null ? 'Webhook URL' : 'Webhook URL（留空不修改）'}
            rules={
              editing === null
                ? [{ required: true }, { type: 'url', message: '请输入 HTTPS URL' }]
                : []
            }
          >
            <Input.Password placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
          </Form.Item>
          <Form.Item
            name="secret"
            label={editing === null ? '签名 Secret' : '签名 Secret（留空不修改）'}
            rules={editing === null ? [{ required: true }] : []}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="events" label="订阅事件" rules={[{ required: true }]}>
            <Checkbox.Group options={EVENT_OPTIONS} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
