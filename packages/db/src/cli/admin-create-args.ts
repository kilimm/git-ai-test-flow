// 本文件所有改动要求遵循 agent-rules 规范

export const ADMIN_PASSWORD_ENV = 'ADMIN_PASSWORD';

export interface AdminCreateArgs {
  help: boolean;
  username?: string | undefined;
  password?: string | undefined;
  tenantSlug?: string | undefined;
  tenantName?: string | undefined;
  displayName?: string | undefined;
  email?: string | undefined;
}

export interface ParseAdminCreateArgsOptions {
  env?: Record<string, string | undefined>;
}

const VALUE_FLAGS: Readonly<Record<string, keyof Omit<AdminCreateArgs, 'help'>>> = {
  '--username': 'username',
  '-u': 'username',
  '--password': 'password',
  '-p': 'password',
  '--tenant-slug': 'tenantSlug',
  '--tenant-name': 'tenantName',
  '--display-name': 'displayName',
  '--email': 'email',
};

/**
 * 解析 admin:create 参数；密码优先取 --password，其次取 ADMIN_PASSWORD 环境变量，
 * 不在命令行帮助中回显密码。
 */
export function parseAdminCreateArgs(
  argv: readonly string[],
  options: ParseAdminCreateArgsOptions = {},
): AdminCreateArgs {
  const args: AdminCreateArgs = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const key = VALUE_FLAGS[flag];

    if (key === undefined) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    let value: string | undefined;

    if (equalsIndex !== -1) {
      value = arg.slice(equalsIndex + 1);
    } else {
      const next = argv[index + 1];

      if (next === undefined || next.startsWith('-')) {
        throw new Error(`${flag} requires a value`);
      }

      value = next;
      index += 1;
    }

    args[key] = value;
  }

  if (args.password === undefined || args.password.length === 0) {
    const fromEnv = (options.env ?? process.env)[ADMIN_PASSWORD_ENV];

    if (fromEnv !== undefined && fromEnv.length > 0) {
      args.password = fromEnv;
    }
  }

  return args;
}
