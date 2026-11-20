// 本文件所有改动要求遵循 agent-rules 规范
import { BookOpen } from 'lucide-react';
import { Card } from 'antd';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { useProject } from '../../components/ProjectLayout';

export default function DocsPage() {
  const { project } = useProject();

  return (
    <div className="space-y-4">
      <PageHeader
        title="项目文档"
        description={`文档根目录 ${project.docsRoot}；模块文档、增量记录与压缩将在 P1 提供`}
      />
      <Card>
        <EmptyState
          icon={<BookOpen size={40} className="mx-auto text-gh-muted" />}
          title="文档能力尚未启用"
          description="P0 聚焦生成、执行、归因与报告闭环；项目文档管理属于 M9-S6，本页为占位入口。"
        />
      </Card>
    </div>
  );
}
