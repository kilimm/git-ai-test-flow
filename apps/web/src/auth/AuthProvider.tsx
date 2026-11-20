// 本文件所有改动要求遵循 agent-rules 规范
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthSessionSummary, TenantSummary } from '@gait/shared';
import { api } from '../api/client';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; session: AuthSessionSummary };

export interface AuthContextValue {
  state: AuthState;
  login(username: string, password: string): Promise<AuthSessionSummary>;
  logout(): Promise<void>;
  switchTenant(tenantId: string): Promise<TenantSummary>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void api
      .getSession()
      .then((session) => {
        if (!cancelled) {
          setState({ status: 'authenticated', session });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'anonymous' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const session = await api.login(username, password);
    setState({ status: 'authenticated', session });
    return session;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 服务端不可达时仍然清理本地会话状态，避免用户被卡在已登录界面。
    } finally {
      setState({ status: 'anonymous' });
    }
  }, []);

  const switchTenant = useCallback(async (tenantId: string) => {
    const result = await api.switchTenant(tenantId);

    setState((current) => {
      if (current.status !== 'authenticated') {
        return current;
      }

      return {
        status: 'authenticated',
        session: {
          ...current.session,
          activeTenant: result.activeTenant,
          tenants: result.tenants,
          permissions: result.permissions,
        },
      };
    });

    return result.activeTenant;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ state, login, logout, switchTenant }),
    [state, login, logout, switchTenant],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (context === undefined) {
    throw new Error('useAuth must be used within AuthProvider');
  }

  return context;
}
