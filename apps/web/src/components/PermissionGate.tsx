// 本文件所有改动要求遵循 agent-rules 规范
import type { Permission } from '@gait/shared';
import type { ReactNode } from 'react';
import { hasPermission } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

export function usePermission(permission: Permission): boolean {
  const { state } = useAuth();

  return state.status === 'authenticated' && hasPermission(state.session.permissions, permission);
}

export default function PermissionGate({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const allowed = usePermission(permission);

  return <>{allowed ? children : fallback}</>;
}
