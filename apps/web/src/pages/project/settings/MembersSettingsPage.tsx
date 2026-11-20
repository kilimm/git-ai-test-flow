// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import {
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
import { Trash2, UserPlus } from 'lucide-react';
import type { TenantRole } from '@gait/shared';
import { api, ApiError } from '../../../api/client';
import type { Member } from '../../../api/types';
import { useAuth } from '../../../auth/AuthProvider';
import ErrorState from '../../../components/ErrorState';
import LoadingSkeleton from '../../../components/LoadingSkeleton';
import PageHeader from '../../../components/PageHeader';
import { useAsync } from '../../../hooks/useAsync';

interface AddMemberFormValues {
  username: string;
  displayName?: string;
  email?: string;
  password?: string;
  role: TenantRole;
}

const ROLE_OPTIONS: { value: TenantRole; label: string }[] = [
  { value: 'viewer', label: '只读' },
  { value: 'developer', label: '开发者' },
  { value: 'admin', label: '管理员' },
  { value: 'owner', label: '所有者' },
];

export default function MembersSettingsPage() {
  const { state } = useAuth();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<AddMemberFormValues>();
  const [openModal, setOpenModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const tenantId = state.status === 'authenticated' ? state.session.activeTenant.id : '';
  const { data, loading, error, reload } = useAsync(
    () => (tenantId === '' ? Promise.resolve([]) : api.listMembers(tenantId)),
    [tenantId],
  );

  if (state.status !== 'authenticated') {
    return null;
  }

  const addMember = async (values: AddMemberFormValues): Promise<void> => {
    setSaving(true);

    try {
      await api.addMember(tenantId, {
        username: values.username,
        role: values.role,
        ...(values.password === undefined ? {} : { password: values.password }),
        ...(values.displayName === undefined ? {} : { displayName: values.displayName }),
        ...(values.email === undefined ? {} : { email: values.email }),
      });
      message.success('成员已添加');
      setOpenModal(false);
      form.resetFields();
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '添加成员失败');
    } finally {
      setSaving(false);
    }
  };

  const updateRole = async (member: Member, role: TenantRole): Promise<void> => {
    setBusyId(member.userId);

    try {
      await api.updateMemberRole(tenantId, member.userId, role);
      message.success('角色已更新');
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '更新角色失败');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (member: Member): Promise<void> => {
    setBusyId(member.userId);

    try {
      await api.removeMember(tenantId, member.userId);
      message.success('成员已移除');
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '移除成员失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="租户成员"
        description="角色权限立即生效；移除成员会撤销其会话"
        actions={
          <Button type="primary" icon={<UserPlus size={15} />} onClick={() => setOpenModal(true)}>
            添加成员
          </Button>
        }
      />

      {loading && data === undefined && <LoadingSkeleton />}
      {error !== undefined && <ErrorState error={error} onRetry={reload} />}

      <Card styles={{ body: { padding: 0 } }}>
        <Table<Member>
          rowKey="userId"
          size="small"
          pagination={false}
          dataSource={data ?? []}
          columns={[
            {
              title: '成员',
              dataIndex: 'username',
              render: (username: string, member) => (
                <div>
                  <span className="text-sm font-medium">{member.displayName}</span>
                  <div className="text-xs text-gh-muted">@{username}</div>
                </div>
              ),
            },
            {
              title: '邮箱',
              dataIndex: 'email',
              render: (email: string | null) => email ?? '-',
            },
            {
              title: '角色',
              dataIndex: 'role',
              render: (role: TenantRole, member) => (
                <Select
                  size="small"
                  value={role}
                  className="w-28"
                  loading={busyId === member.userId}
                  options={ROLE_OPTIONS}
                  onChange={(nextRole) => void updateRole(member, nextRole)}
                />
              ),
            },
            {
              title: '状态',
              dataIndex: 'status',
              render: (status: string) => <Tag>{status}</Tag>,
            },
            {
              title: '最近登录',
              dataIndex: 'lastLoginAt',
              render: (value: string | null) =>
                value === null ? '-' : new Date(value).toLocaleString('zh-CN'),
            },
            {
              title: '操作',
              width: 120,
              render: (_value, member) => (
                <Popconfirm
                  title="移除成员"
                  description="该成员会立即失去租户访问权限。"
                  okText="移除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void remove(member)}
                >
                  <Button
                    size="small"
                    danger
                    icon={<Trash2 size={13} />}
                    loading={busyId === member.userId}
                    disabled={member.userId === state.session.user.id}
                  >
                    移除
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={openModal}
        title="添加成员"
        okText="添加"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => setOpenModal(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<AddMemberFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ role: 'developer' }}
          onFinish={(values) => {
            void addMember(values);
          }}
        >
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input placeholder="alice" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名称">
            <Input placeholder="Alice" />
          </Form.Item>
          <Form.Item name="email" label="邮箱">
            <Input type="email" placeholder="alice@example.com" />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            extra="新用户必须设置初始密码；已有用户可留空。"
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
