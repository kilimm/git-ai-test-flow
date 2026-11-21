// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import { Alert, Button, Card, Divider, Form, Input, Typography } from 'antd';
import { FlaskConical, KeyRound, LockKeyhole, UserRound } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { SsoProvider } from '../api/types';
import { useAuth } from '../auth/AuthProvider';

interface LoginFormValues {
  username: string;
  password: string;
}

export default function LoginPage() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [ssoSlug, setSsoSlug] = useState('');
  const [ssoProviders, setSsoProviders] = useState<SsoProvider[]>([]);
  const [ssoLoading, setSsoLoading] = useState(false);

  if (state.status === 'authenticated') {
    return <Navigate to={`/t/${state.session.activeTenant.slug}/projects`} replace />;
  }

  const handleLogin = async (values: LoginFormValues): Promise<void> => {
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const session = await login(values.username, values.password);
      navigate(`/t/${session.activeTenant.slug}/projects`, { replace: true });
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : '登录失败，请检查网络后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const discoverSso = async (): Promise<void> => {
    setSsoLoading(true);

    try {
      const providers = await api.listSsoProviders(ssoSlug.trim());
      setSsoProviders(providers);

      if (providers.length === 0) {
        setErrorMessage('该租户没有启用的 SSO Provider');
      }
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : 'SSO 发现失败');
    } finally {
      setSsoLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gh-canvas px-4">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gh-green text-white">
          <FlaskConical size={22} />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-gh-text">git-ai-test-flow</h1>
          <p className="text-sm text-gh-muted">AI 驱动的 Git 变更测试平台</p>
        </div>
      </div>

      <Card className="w-full max-w-[380px] shadow-sm">
        <Typography.Title level={4} className="!mb-1">
          登录
        </Typography.Title>
        <p className="mb-5 text-sm text-gh-muted">使用管理员分配的账号登录</p>

        {errorMessage !== null && (
          <Alert type="error" showIcon message={errorMessage} className="mb-4" />
        )}

        <Form<LoginFormValues>
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            void handleLogin(values);
          }}
        >
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              prefix={<UserRound size={16} className="text-gh-muted" />}
              autoComplete="username"
              autoFocus
              size="large"
              placeholder="username"
            />
          </Form.Item>

          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockKeyhole size={16} className="text-gh-muted" />}
              autoComplete="current-password"
              size="large"
              placeholder="至少 12 位"
            />
          </Form.Item>

          <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
            登录
          </Button>
        </Form>

        <Divider plain className="!my-4 text-xs text-gh-muted">
          或使用企业 SSO
        </Divider>
        <div className="flex gap-2">
          <Input
            placeholder="租户 slug"
            value={ssoSlug}
            onChange={(event) => setSsoSlug(event.target.value)}
          />
          <Button
            icon={<KeyRound size={14} />}
            loading={ssoLoading}
            disabled={ssoSlug.trim().length === 0}
            onClick={() => void discoverSso()}
          >
            发现
          </Button>
        </div>
        {ssoProviders.length > 0 && (
          <div className="mt-2 space-y-2">
            {ssoProviders.map((provider) => (
              <Button
                key={provider.id}
                block
                onClick={() => {
                  window.location.href = api.ssoStartUrl(provider.id, '/');
                }}
              >
                {provider.name}
              </Button>
            ))}
          </div>
        )}
      </Card>

      <p className="mt-6 text-center text-xs text-gh-muted">
        平台不开放匿名注册；首个管理员通过 pnpm admin:create 创建。
      </p>
    </div>
  );
}
