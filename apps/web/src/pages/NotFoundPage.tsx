// 本文件所有改动要求遵循 agent-rules 规范
import { Button, Result } from 'antd';
import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gh-canvas">
      <Result
        status="404"
        title="页面不存在"
        subTitle="链接可能已失效，或你没有访问该页面的权限。"
        extra={
          <Link to="/">
            <Button type="primary">返回首页</Button>
          </Link>
        }
      />
    </div>
  );
}
