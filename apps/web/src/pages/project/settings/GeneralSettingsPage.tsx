// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import { App as AntdApp, Button, Card, Form, Input, Modal, Select } from 'antd';
import { Save, Trash2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../../api/client';
import type { ProjectInput } from '../../../api/client';
import PageHeader from '../../../components/PageHeader';
import { useProject } from '../../../components/ProjectLayout';

interface FormValues {
  name: string;
  defaultBranch: string;
  suiteMode: 'managed' | 'external' | 'same_repo';
  suiteRepoUrl?: string;
  suitePath?: string;
  featureRoot: string;
  docsRoot: string;
}

export default function GeneralSettingsPage() {
  const { project, reloadProject } = useProject();
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { tenantSlug } = useParams();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const suiteMode = Form.useWatch('suiteMode', form);

  const save = async (values: FormValues): Promise<void> => {
    setSaving(true);

    try {
      const input: Partial<ProjectInput> = {
        name: values.name,
        defaultBranch: values.defaultBranch,
        suiteMode: values.suiteMode,
        suiteRepoUrl: values.suiteMode === 'external' ? (values.suiteRepoUrl ?? null) : null,
        suitePath: values.suiteMode === 'same_repo' ? (values.suitePath ?? null) : null,
        featureRoot: values.featureRoot,
        docsRoot: values.docsRoot,
      };

      await api.updateProject(project.id, input);
      message.success('项目设置已保存');
      reloadProject();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = (): void => {
    Modal.confirm({
      title: '删除项目',
      content: '删除后项目下的环境、生成、运行与配置将不可访问。此操作不可撤销。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setDeleting(true);

        try {
          await api.deleteProject(project.id);
          message.success('项目已删除');
          navigate(`/t/${tenantSlug}/projects`, { replace: true });
        } catch (cause) {
          message.error(cause instanceof ApiError ? cause.message : '删除失败');
        } finally {
          setDeleting(false);
        }
      },
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader title="常规设置" description="项目名称、分支与 Suite 布局" />
      <Card>
        <Form<FormValues>
          key={`${project.id}-${project.updatedAt}`}
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{
            name: project.name,
            defaultBranch: project.defaultBranch,
            suiteMode: project.suiteMode,
            suiteRepoUrl: project.suiteRepoUrl ?? undefined,
            suitePath: project.suitePath ?? undefined,
            featureRoot: project.featureRoot,
            docsRoot: project.docsRoot,
          }}
          onFinish={(values) => {
            void save(values);
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Form.Item name="name" label="项目名称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item label="Slug">
              <Input value={project.slug} disabled />
            </Form.Item>
            <Form.Item label="产品仓库 URL">
              <Input value={project.productRepoUrl} disabled />
            </Form.Item>
            <Form.Item name="defaultBranch" label="默认分支" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="suiteMode" label="Suite 模式" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'managed', label: 'managed' },
                  { value: 'external', label: 'external' },
                  { value: 'same_repo', label: 'same_repo' },
                ]}
              />
            </Form.Item>
            {suiteMode === 'external' && (
              <Form.Item name="suiteRepoUrl" label="Suite 仓库 URL">
                <Input />
              </Form.Item>
            )}
            {suiteMode === 'same_repo' && (
              <Form.Item name="suitePath" label="Suite 路径">
                <Input />
              </Form.Item>
            )}
            <Form.Item name="featureRoot" label="用例根目录" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="docsRoot" label="文档根目录" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </div>
          <Button type="primary" htmlType="submit" loading={saving} icon={<Save size={15} />}>
            保存设置
          </Button>
        </Form>
      </Card>

      <Card title="危险操作" className="border-[#ffebe9]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-gh-muted">
            删除项目会移除项目配置、环境、生成记录与运行入口。
          </p>
          <Button danger loading={deleting} icon={<Trash2 size={15} />} onClick={remove}>
            删除项目
          </Button>
        </div>
      </Card>
    </div>
  );
}
