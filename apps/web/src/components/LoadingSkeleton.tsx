// 本文件所有改动要求遵循 agent-rules 规范
import { Card, Skeleton } from 'antd';

export default function LoadingSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card>
      <Skeleton active paragraph={{ rows }} />
    </Card>
  );
}
