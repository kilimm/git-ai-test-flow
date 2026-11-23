// 本文件所有改动要求遵循 agent-rules 规范
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Button, Empty, Space, Tag, Tree, Typography } from 'antd';
import type { TreeDataNode } from 'antd';
import { FolderTree, RefreshCw } from 'lucide-react';
import type { ModuleTreeNode } from '@gait/shared';

interface ModulePickerProps {
  modules: ModuleTreeNode[];
  value?: string[];
  onChange?: (value: string[]) => void;
  loading?: boolean;
  truncation?: boolean;
  onScan?: () => void;
  /** 表单内展示更紧凑。 */
  compact?: boolean;
}

type ModuleTreeDataNode = TreeDataNode & {
  key: string;
  title: ReactNode;
};

/** 后端模块树 → antd Tree；父节点展示累计功能点数。 */
function toTreeData(nodes: readonly ModuleTreeNode[]): ModuleTreeDataNode[] {
  return nodes.map((node) => {
    const result: ModuleTreeDataNode = {
      key: node.key,
      title: (
        <span className="inline-flex items-center gap-2">
          <span className="text-sm">{node.label}</span>
          <Tag className="m-0 font-mono text-[11px]">{node.key}</Tag>
          <Typography.Text type="secondary" className="text-xs">
            {node.featurePoints}
          </Typography.Text>
        </span>
      ),
    };

    if (node.children.length > 0) {
      (result as { children?: ModuleTreeDataNode[] }).children = toTreeData(node.children);
    }

    return result;
  });
}

/**
 * 模块多选：选择父模块即命中整棵子树（前缀匹配由后端保证）。
 * 不选任何模块 = 全部模块（前端在提交时省略 selection）。
 */
export default function ModulePicker({
  modules,
  value = [],
  onChange,
  loading = false,
  truncation = false,
  onScan,
  compact = false,
}: ModulePickerProps) {
  const treeData = useMemo(() => toTreeData(modules), [modules]);
  const empty = modules.length === 0;

  return (
    <div className="space-y-2">
      <Space size="small" wrap>
        <Button
          size={compact ? 'small' : 'middle'}
          icon={<RefreshCw size={13} />}
          loading={loading}
          onClick={onScan}
          disabled={onScan === undefined}
        >
          {empty ? '扫描代码库模块' : '重新扫描模块'}
        </Button>
        {value.length > 0 && (
          <Button size={compact ? 'small' : 'middle'} onClick={() => onChange?.([])}>
            清空（全部模块）
          </Button>
        )}
        {truncation && (
          <Typography.Text type="warning" className="text-xs">
            模块清单可能不完整（超出扫描上限），可手填模块 key
          </Typography.Text>
        )}
      </Space>
      {empty ? (
        <Empty
          image={<FolderTree size={28} className="mx-auto text-gh-muted" />}
          imageStyle={{ height: 28 }}
          description="尚未识别模块；扫描后可选模块，也可直接留空生成全部"
        />
      ) : (
        <div className="max-h-64 overflow-auto rounded border border-gh-border p-2">
          <Tree
            checkable
            blockNode
            defaultExpandAll
            treeData={treeData}
            checkedKeys={value}
            onCheck={(checked) => {
              const keys = Array.isArray(checked) ? checked : checked.checked;
              onChange?.(keys.filter((key): key is string => typeof key === 'string'));
            }}
          />
        </div>
      )}
    </div>
  );
}
