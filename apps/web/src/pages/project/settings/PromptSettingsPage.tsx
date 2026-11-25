// 本文件所有改动要求遵循 agent-rules 规范
import { useEffect, useState } from 'react';
import { Alert, App as AntdApp, Button, Card, Input, Tag } from 'antd';
import { FileText, RotateCcw, Save } from 'lucide-react';
import { api, ApiError } from '../../../api/client';
import type { PromptStage } from '../../../api/types';
import PageHeader from '../../../components/PageHeader';
import { useAsync } from '../../../hooks/useAsync';

/**
 * 生成阶段提示词管理（tenant 级）。
 *
 * 四个阶段（summarize / extract / design / critique）的系统提示词统一在这里编辑：
 * - 留空 = 使用内置默认（代码常量），不在 DB 里产生覆盖；
 * - 保存后所有新建生成任务都会使用最新内容（version+1，可追溯到修改人）。
 */
export default function PromptSettingsPage() {
  const { message } = AntdApp.useApp();
  const { data, loading, error, reload } = useAsync(() => api.listPromptTemplates(), []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (data === undefined) {
      return;
    }

    setDrafts(Object.fromEntries(data.map((stage) => [stage.stage, stage.content])));
  }, [data]);

  const save = async (stage: PromptStage): Promise<void> => {
    setSaving(stage.stage);

    try {
      const content = (drafts[stage.stage] ?? '').trim();

      // 内容与默认一致时保存空串，避免无意义的 custom 覆盖。
      const next = content === stage.defaultContent.trim() ? '' : (drafts[stage.stage] ?? '');
      await api.savePromptTemplate(stage.stage, next);
      message.success(`${stage.label} 已保存`);
      reload();
    } catch (cause) {
      message.error(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(null);
    }
  };

  const items = data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="提示词"
        description="统一管理生成各阶段的系统提示词；留空则使用内置默认"
      />

      {error !== undefined && (
        <Alert type="error" showIcon message="加载提示词失败" description={error.message} />
      )}
      {loading && data === undefined && <Card loading />}

      {items.map((stage) => {
        const draft = drafts[stage.stage] ?? '';
        const customized = draft.trim() !== stage.defaultContent.trim();

        return (
          <Card
            key={stage.stage}
            title={
              <span className="flex items-center gap-2">
                <FileText size={15} />
                {stage.label}
                <code className="text-xs text-gh-muted">{stage.stage}</code>
                {stage.customized ? <Tag color="gold">已自定义 v{stage.version}</Tag> : <Tag>默认</Tag>}
              </span>
            }
            extra={
              <div className="flex gap-2">
                <Button
                  size="small"
                  icon={<RotateCcw size={13} />}
                  onClick={() => {
                    setDrafts((previous) => ({
                      ...previous,
                      [stage.stage]: stage.defaultContent,
                    }));
                  }}
                >
                  恢复默认
                </Button>
                <Button
                  size="small"
                  type="primary"
                  icon={<Save size={13} />}
                  loading={saving === stage.stage}
                  disabled={!customized}
                  onClick={() => {
                    void save(stage);
                  }}
                >
                  保存
                </Button>
              </div>
            }
          >
            <p className="mt-0 mb-2 text-xs text-gh-muted">{stage.description}</p>
            <Input.TextArea
              value={draft}
              onChange={(event) => {
                setDrafts((previous) => ({ ...previous, [stage.stage]: event.target.value }));
              }}
              autoSize={{ minRows: 8, maxRows: 24 }}
              className="font-mono"
            />
            {stage.updatedAt !== null && (
              <p className="mt-2 mb-0 text-xs text-gh-muted">
                最后更新：{new Date(stage.updatedAt).toLocaleString('zh-CN')}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}
