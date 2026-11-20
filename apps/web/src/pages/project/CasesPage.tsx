// 本文件所有改动要求遵循 agent-rules 规范
import { useMemo, useState } from 'react';
import { Card, Descriptions, Drawer, Input, Select, Table, Tag } from 'antd';
import { FlaskConical, FolderTree, Search } from 'lucide-react';
import { api } from '../../api/client';
import type { CaseItem } from '../../api/types';
import EmptyState from '../../components/EmptyState';
import ErrorState from '../../components/ErrorState';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import PageHeader from '../../components/PageHeader';
import StatusBadge from '../../components/StatusBadge';
import { useProject } from '../../components/ProjectLayout';
import { useAsync } from '../../hooks/useAsync';

export default function CasesPage() {
  const { project } = useProject();
  const [search, setSearch] = useState('');
  const [moduleFilter, setModuleFilter] = useState<string | undefined>(undefined);
  const [currentData, setCurrentData] = useState<CaseItem | null>(null);
  const { data, loading, error, reload } = useAsync(
    () => Promise.all([api.listCases(project.id), api.listFeatureFiles(project.id)]),
    [project.id],
  );
  const cases = data?.[0] ?? [];
  const files = data?.[1] ?? [];
  const modules = useMemo(() => [...new Set(cases.map((item) => item.moduleKey))].sort(), [cases]);
  const filtered = cases.filter((item) => {
    if (moduleFilter !== undefined && item.moduleKey !== moduleFilter) {
      return false;
    }

    const keyword = search.trim().toLowerCase();

    return (
      keyword.length === 0 ||
      item.name.toLowerCase().includes(keyword) ||
      item.caseKey.toLowerCase().includes(keyword) ||
      item.featurePath.toLowerCase().includes(keyword)
    );
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="用例索引"
        description="索引来自 Suite 仓库，可重建；Git 仍是事实源"
        actions={
          <div className="flex flex-wrap gap-2">
            <Input
              allowClear
              prefix={<Search size={15} className="text-gh-muted" />}
              placeholder="搜索场景 / caseKey / 文件"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-64"
            />
            <Select
              allowClear
              placeholder="模块"
              className="w-40"
              value={moduleFilter}
              onChange={setModuleFilter}
              options={modules.map((module) => ({ value: module, label: module }))}
            />
          </div>
        }
      />

      {loading && data === undefined && <LoadingSkeleton />}
      {error !== undefined && <ErrorState error={error} onRetry={reload} />}

      {data !== undefined && cases.length === 0 && (
        <Card>
          <EmptyState
            icon={<FlaskConical size={40} className="mx-auto text-gh-muted" />}
            title="还没有索引用例"
            description="完成一次生成审批，或在 Suite 中同步 feature 后即可查看。"
          />
        </Card>
      )}

      {data !== undefined && cases.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card
            title={
              <span className="flex items-center gap-2">
                <FolderTree size={15} /> Feature 文件
              </span>
            }
            size="small"
          >
            <div className="space-y-2">
              {files.map((file) => (
                <div key={file.id} className="rounded border border-gh-border p-2">
                  <div className="break-all text-xs font-medium">{file.path}</div>
                  <div className="mt-1 flex flex-wrap gap-1 text-xs text-gh-muted">
                    <Tag>{file.moduleKey ?? 'unknown'}</Tag>
                    <span>{file.scenarioCount} 场景</span>
                    <StatusBadge
                      status={file.parseStatus === 'parsed' ? 'active' : file.parseStatus}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title={`场景（${filtered.length}）`} styles={{ body: { padding: 0 } }}>
            <Table<CaseItem>
              rowKey="id"
              size="small"
              dataSource={filtered}
              pagination={{ pageSize: 30, hideOnSinglePage: true }}
              onRow={(record) => ({
                onClick: () => setCurrentData(record),
                className: 'cursor-pointer',
              })}
              columns={[
                {
                  title: '场景',
                  dataIndex: 'name',
                  render: (name: string, item) => (
                    <div>
                      <span className="text-sm font-medium">{name}</span>
                      <div className="text-xs text-gh-muted">
                        <code>
                          {item.featurePath}:{item.line}
                        </code>
                      </div>
                    </div>
                  ),
                },
                {
                  title: 'Case Key',
                  dataIndex: 'caseKey',
                  render: (value: string) => <code className="text-xs">{value}</code>,
                },
                {
                  title: '模块',
                  dataIndex: 'moduleKey',
                  render: (value: string) => <Tag>{value}</Tag>,
                },
                {
                  title: 'Layer',
                  dataIndex: 'tags',
                  render: (tags: string[]) => {
                    const layer = tags.find((tag) => tag.startsWith('layer:'));

                    return layer === undefined ? '-' : <Tag>{layer.slice(6)}</Tag>;
                  },
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  render: (status: string) => <StatusBadge status={status} />,
                },
              ]}
            />
          </Card>
        </div>
      )}

      <Drawer
        open={currentData !== null}
        onClose={() => setCurrentData(null)}
        title={currentData?.name}
        width={560}
      >
        {currentData !== null && (
          <Descriptions
            size="small"
            column={1}
            bordered
            items={[
              { key: 'caseKey', label: 'Case Key', children: currentData.caseKey },
              {
                key: 'feature',
                label: 'Feature',
                children: <code>{currentData.featurePath}</code>,
              },
              { key: 'line', label: '行号', children: currentData.line },
              { key: 'module', label: '模块', children: currentData.moduleKey },
              {
                key: 'tags',
                label: 'Tags',
                children: currentData.tags.map((tag) => <Tag key={tag}>{tag}</Tag>),
              },
              {
                key: 'status',
                label: '状态',
                children: <StatusBadge status={currentData.status} />,
              },
              {
                key: 'fingerprint',
                label: '指纹',
                children: <code className="break-all text-xs">{currentData.fingerprint}</code>,
              },
            ]}
          />
        )}
        <p className="mt-4 text-xs text-gh-muted">
          场景正文由 Suite Git 管理；P0 GUI 提供索引与元数据查看，在线编辑在 P1
          文档/用例管理中完善。
        </p>
      </Drawer>
    </div>
  );
}
