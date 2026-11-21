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
  Switch,
  Table,
  Tag,
} from 'antd';
import { Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { PERMISSION } from '@gait/shared';
import { api, ApiError } from '../../../api/client';
import type { ProjectRole } from '../../../api/types';
import ErrorState from '../../../components/ErrorState';
import LoadingSkeleton from '../../../components/LoadingSkeleton';
import PageHeader from '../../../components/PageHeader';
import PermissionGate from '../../../components/PermissionGate';
import { useProject } from '../../../components/ProjectLayout';
import { useAsync } from '../../../hooks/useAsync';

const ROLE_LABELS: Record<ProjectRole, string> = {
  viewer: '只读',
  developer: '开发者',
  admin: '管理员',
};

interface AddMemberValues {
  username: string;
  role: ProjectRole;
}

export default function AccessSettingsPage() {
  const { project } = useProject();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<AddMemberValues>();
  const [openModal, setOpenModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const {
    data: access,
    loading,
    error,
    reload,
  } = useAsync(() => api.getProjectAccess(project.id), [project.id]);

  const setAccessMode = async (restricted: boolean): Promise<void> => {
    setSaving(true);

    try {
      const updated = await api.updateProjectAccess(
        project.id,
        restricted ? 'restricted' : 'tenant',
      );
      message.success(restricted ? '已启用项目成员限制' : '已恢复租户成员可见');
      void updated;
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '更新访问模式失败');
    } finally {
      setSaving(false);
    }
  };

  const addMember = async (values: AddMemberValues): Promise<void> => {
    setSaving(true);

    try {
      await api.addProjectMember(project.id, values.username, values.role);
      message.success('项目成员已添加');
      setOpenModal(false);
      form.resetFields();
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '添加成员失败');
    } finally {
      setSaving(false);
    }
  };

  const updateRole = async (userId: string, role: ProjectRole): Promise<void> => {
    try {
      await api.updateProjectMember(project.id, userId, role);
      message.success('角色已更新');
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '更新角色失败');
    }
  };

  const remove = async (userId: string): Promise<void> => {
    try {
      await api.removeProjectMember(project.id, userId);
      message.success('项目成员已移除');
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '移除成员失败');
    }
  };

  if (loading && access === undefined) {
    return <LoadingSkeleton />;
  }

  if (error !== undefined) {
    return <ErrorState error={error} onRetry={reload} />;
  }

  if (access === undefined) {
    return <Alert type="error" showIcon message="无法读取项目访问配置" />;
  }

  const canManage = access.canManage;

  return (
    <div className="space-y-4">
      <PageHeader
        title="项目访问"
        description="项目成员只用于限制访问，不会扩大租户角色已有的权限"
        actions={
          <Button icon={<RefreshCw size={15} />} onClick={reload}>
            刷新
          </Button>
        }
      />

      <Card title="访问模式">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck size={16} />
              仅项目成员可访问
            </div>
            <p className="mt-1 max-w-xl text-sm text-gh-muted">
              关闭时，租户内所有成员按租户 RBAC 访问；开启后，非项目成员访问项目及其资源统一返回
              404。租户 Owner/Admin 始终保留访问。
            </p>
          </div>
          <PermissionGate permission={PERMISSION.PROJECT_UPDATE}>
            <Switch
              checked={access.accessMode === 'restricted'}
              loading={saving}
              checkedChildren="受限"
              unCheckedChildren="租户"
              onChange={(checked) => void setAccessMode(checked)}
            />
          </PermissionGate>
        </div>
        {!canManage && (
          <Alert
            className="mt-3"
            type="info"
            showIcon
            message="当前项目角色为只读，不能管理访问配置。"
          />
        )}
      </Card>

      <Card
        title={`项目成员（${access.members.length}）`}
        extra={
          <PermissionGate permission={PERMISSION.PROJECT_UPDATE}>
            <Button
              type="primary"
              size="small"
              icon={<Plus size={14} />}
              disabled={!canManage}
              onClick={() => setOpenModal(true)}
            >
              添加成员
            </Button>
          </PermissionGate>
        }
      >
        <Table
          rowKey="userId"
          size="small"
          pagination={false}
          dataSource={access.members}
          locale={{ emptyText: '暂无项目成员' }}
          columns={[
            {
              title: '用户',
              dataIndex: 'displayName',
              render: (name: string, member) => (
                <div>
                  <div className="text-sm">{name}</div>
                  <div className="text-xs text-gh-muted">@{member.username}</div>
                </div>
              ),
            },
            {
              title: '项目角色',
              dataIndex: 'role',
              render: (role: ProjectRole, member) => (
                <Select
                  size="small"
                  value={role}
                  disabled={!canManage}
                  className="w-28"
                  options={(['viewer', 'developer', 'admin'] as ProjectRole[]).map((value) => ({
                    value,
                    label: ROLE_LABELS[value],
                  }))}
                  onChange={(value: ProjectRole) => void updateRole(member.userId, value)}
                />
              ),
            },
            {
              title: '加入时间',
              dataIndex: 'createdAt',
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
            {
              title: '',
              width: 70,
              render: (_value, member) => (
                <PermissionGate permission={PERMISSION.PROJECT_UPDATE}>
                  <Popconfirm
                    title="移除项目成员"
                    description="该用户将无法继续访问此项目。"
                    okText="移除"
                    cancelText="取消"
                    disabled={!canManage}
                    onConfirm={() => void remove(member.userId)}
                  >
                    <Button danger size="small" icon={<Trash2 size={13} />} disabled={!canManage} />
                  </Popconfirm>
                </PermissionGate>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={openModal}
        title="添加项目成员"
        okText="添加"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => setOpenModal(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<AddMemberValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ role: 'viewer' }}
          onFinish={(values) => void addMember(values)}
        >
          <Form.Item
            name="username"
            label="租户成员用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input placeholder="username" />
          </Form.Item>
          <Form.Item name="role" label="项目角色" rules={[{ required: true }]}>
            <Select
              options={(['viewer', 'developer', 'admin'] as ProjectRole[]).map((value) => ({
                value,
                label: ROLE_LABELS[value],
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Tag className="font-mono">effective role: {access.effectiveRole ?? 'none'}</Tag>
    </div>
  );
}
