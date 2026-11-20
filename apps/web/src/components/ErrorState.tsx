// 本文件所有改动要求遵循 agent-rules 规范
import { Alert, Button } from 'antd';
import { RotateCw } from 'lucide-react';

export interface ErrorStateProps {
  error: Error;
  onRetry?: () => void;
}

export default function ErrorState({ error, onRetry }: ErrorStateProps) {
  return (
    <Alert
      type="error"
      showIcon
      message="加载失败"
      description={error.message}
      action={
        onRetry === undefined ? undefined : (
          <Button size="small" icon={<RotateCw size={14} />} onClick={onRetry}>
            重试
          </Button>
        )
      }
    />
  );
}
