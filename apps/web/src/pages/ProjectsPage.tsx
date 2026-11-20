// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import { App as AntdApp, Button, Card, Form, Input, Modal, Select, Tag } from 'antd';
import { FolderGit2, Plus, Search } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PERMISSION } from '@gait/shared';
import { api, ApiError } from '../api/client';
import type { ProjectInput } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import EmptyState from '../components/EmptyState';
import ErrorState from '../components/ErrorState';
import LoadingSkeleton from '../components/LoadingSkeleton';
import PageHeader from '../components/PageHeader';
import PermissionGate from '../components/PermissionGate';
import { useAsync } from '../hooks/useAsync';

interface ProjectFormValues {
  name: string;
  slug: string;
  productRepoUrl: string;
  defaultBranch: string;
  suiteMode: 'managed' | 'external' | 'same_repo';
  suiteRepoUrl?: string;
  suitePath?: string;
  featureRoot?: string;
  docsRoot?: string;
}

export default function ProjectsPage() {
  const { state } = useAuth();
  const { tenantSlug } = useParams();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [search, setSearch] = useState('');
  const [openModal, setOpenModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<ProjectFormValues>();
  const suiteMode = Form.useWatch('suiteMode', form);
  const tenantId = state.status === 'authenticated' ? state.session.activeTenant.id : '';
  const { data, loading, error, reload } = useAsync(
    () => (tenantId === '' ? Promise.resolve([]) : api.listProjects(tenantId)),
    [tenantId],
  );

  if (state.status !== 'authenticated') {
    return null;
  }

  const projects = (data ?? []).filter((project) => {
    const keyword = search.trim().toLowerCase();

    return (
      keyword.length === 0 ||
      project.name.toLowerCase().includes(keyword) ||
      project.slug.toLowerCase().includes(keyword)
    );
  });

  const submit = async (values: ProjectFormValues): Promise<void> => {
    setSubmitting(true);

    try {
      const input: ProjectInput = {
        name: values.name,
        slug: values.slug,
        productRepoUrl: values.productRepoUrl,
        defaultBranch: values.defaultBranch,
        suiteMode: values.suiteMode,
        featureRoot: values.featureRoot ?? 'features/',
        docsRoot: values.docsRoot ?? 'docs/ai/',
        ...(values.suiteMode === 'external' && values.suiteRepoUrl !== undefined
          ? { suiteRepoUrl: values.suiteRepoUrl }
          : {}),
        ...(values.suiteMode === 'same_repo' && values.suitePath !== undefined
          ? { suitePath: values.suitePath }
          : {}),
      };
      const project = await api.createProject(state.session.activeTenant.id, input);

      message.success('项目已创建');
      setOpenModal(false);
      form.resetFields();
      navigate(`/t/${state.session.activeTenant.slug}/p/${project.slug}/overview`);
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '创建项目失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={state.session.activeTenant.name}
        description={`当前用户 @${state.session.user.username} · 租户 ${state.session.activeTenant.slug}`}
        actions={
          <>
            <Input
              allowClear
              prefix={<Search size={15} className="text-gh-muted" />}
              placeholder="搜索项目"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-56"
            />
            <PermissionGate permission={PERMISSION.PROJECT_CREATE}>
              <Button type="primary" icon={<Plus size={16} />} onClick={() => setOpenModal(true)}>
                新建项目
              </Button>
            </PermissionGate>
          </>
        }
      />

      {loading && data === undefined && <LoadingSkeleton />}
      {error !== undefined && <ErrorState error={error} onRetry={reload} />}

      {data !== undefined && projects.length === 0 && (
        <Card>
          <EmptyState
            icon={
              <div className="flex justify-center text-gh-muted">
                <FolderGit2 size={44} strokeWidth={1.5} />
              </div>
            }
            title={search.length > 0 ? '没有匹配的项目' : '还没有项目'}
            description={
              search.length > 0
                ? '尝试修改搜索关键词。'
                : '创建项目后即可配置 Git 凭据、测试环境与 LLM Profile。'
            }
            action={
              search.length === 0 ? (
                <PermissionGate permission={PERMISSION.PROJECT_CREATE}>
                  <Button
                    type="primary"
                    icon={<Plus size={16} />}
                    onClick={() => setOpenModal(true)}
                  >
                    新建项目
                  </Button>
                </PermissionGate>
              ) : undefined
            }
          />
        </Card>
      )}

      {projects.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {projects.map((project) => (
            <Link
              key={project.id}
              to={`/t/${tenantSlug}/p/${project.slug}/overview`}
              className="no-underline"
            >
              <Card hoverable className="h-full">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FolderGit2 size={17} className="text-gh-muted" />
                      <span className="truncate text-sm font-semibold text-gh-blue">
                        {project.name}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-gh-muted">{project.productRepoUrl}</p>
                  </div>
                  <Tag color="blue">{project.suiteMode}</Tag>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-gh-muted">
                  <span>
                    默认分支 <code className="font-mono">{project.defaultBranch}</code>
                  </span>
                  <span>·</span>
                  <span>用例根目录 {project.featureRoot}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Modal
        open={openModal}
        title="新建项目"
        okText="创建"
        cancelText="取消"
        confirmLoading={submitting}
        onCancel={() => setOpenModal(false)}
        onOk={() => {
          form.submit();
        }}
        destroyOnHidden
      >
        <Form<ProjectFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{
            suiteMode: 'managed',
            defaultBranch: 'main',
            featureRoot: 'features/',
            docsRoot: 'docs/ai/',
          }}
          onFinish={(values) => {
            void submit(values);
          }}
        >
          <Form.Item name="name" label="项目名称" rules={[{ required: true }]}>
            <Input placeholder="Demo App" />
          </Form.Item>
          <Form.Item
            name="slug"
            label="Slug"
            rules={[
              { required: true },
              { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '仅小写字母、数字与连字符' },
            ]}
          >
            <Input placeholder="demo-app" />
          </Form.Item>
          <Form.Item
            name="productRepoUrl"
            label="产品仓库 URL"
            rules={[{ required: true }, { type: 'url' }]}
          >
            <Input placeholder="https://github.com/org/demo-app" />
          </Form.Item>
          <Form.Item name="defaultBranch" label="默认分支" rules={[{ required: true }]}>
            <Input placeholder="main" />
          </Form.Item>
          <Form.Item name="suiteMode" label="Suite 模式" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'managed', label: 'managed（平台管理 Suite）' },
                { value: 'external', label: 'external（独立 Suite 仓库）' },
                { value: 'same_repo', label: 'same_repo（产品仓库内）' },
              ]}
            />
          </Form.Item>
          {suiteMode === 'external' && (
            <Form.Item
              name="suiteRepoUrl"
              label="Suite 仓库 URL"
              rules={[{ required: true }, { type: 'url' }]}
            >
              <Input placeholder="https://github.com/org/demo-suite" />
            </Form.Item>
          )}
          {suiteMode === 'same_repo' && (
            <Form.Item name="suitePath" label="Suite 相对路径" rules={[{ required: true }]}>
              <Input placeholder="tests/e2e" />
            </Form.Item>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="featureRoot" label="用例根目录">
              <Input placeholder="features/" />
            </Form.Item>
            <Form.Item name="docsRoot" label="文档根目录">
              <Input placeholder="docs/ai/" />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
