// 本文件所有改动要求遵循 agent-rules 规范
import { loadDotEnv } from '@gait/config';
import { createPlatformAdmin } from '../admin.js';
import { openDatabase } from '../client.js';
import { runMigrations } from '../migrate.js';
import { parseAdminCreateArgs } from './admin-create-args.js';

const DEFAULT_DATABASE_PATH = './data/app.db';

function printHelp(): void {
  process.stdout.write(
    [
      '用法: pnpm admin:create --username <name> [--password <password>]',
      '',
      '创建首个平台管理员，并创建/复用租户后授予 OWNER。',
      '密码也可通过 ADMIN_PASSWORD 环境变量提供，避免出现在 shell 历史中。',
      '',
      '参数:',
      '  -u, --username <name>       登录用户名（小写字母、数字、. _ -）',
      '  -p, --password <password>   初始密码（至少 12 位）',
      '      --tenant-slug <slug>    租户 slug，默认 default',
      '      --tenant-name <name>    租户名称，默认 Default Workspace',
      '      --display-name <name>   显示名称，默认与用户名相同',
      '      --email <email>         邮箱（可选）',
      '  -h, --help                  显示帮助',
      '',
      `已存在平台管理员时命令会被拒绝；数据库路径取 DATABASE_PATH，默认 ${DEFAULT_DATABASE_PATH}。`,
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  loadDotEnv();

  const args = parseAdminCreateArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const username = args.username?.trim();

  if (username === undefined || username.length === 0) {
    throw new Error('--username is required (see --help)');
  }

  const password = args.password;

  if (password === undefined || password.length === 0) {
    throw new Error('--password or ADMIN_PASSWORD is required (see --help)');
  }

  const databasePath = process.env['DATABASE_PATH'] ?? DEFAULT_DATABASE_PATH;
  const database = openDatabase({ path: databasePath });

  try {
    runMigrations(database);

    const result = await createPlatformAdmin(database.db, {
      username,
      password,
      ...(args.tenantSlug === undefined ? {} : { tenantSlug: args.tenantSlug }),
      ...(args.tenantName === undefined ? {} : { tenantName: args.tenantName }),
      ...(args.displayName === undefined ? {} : { displayName: args.displayName }),
      ...(args.email === undefined ? {} : { email: args.email }),
    });

    process.stdout.write(
      [
        `Created platform administrator "${result.user.username}" (${result.user.id}).`,
        `Tenant: ${result.tenant.name} [${result.tenant.slug}] (${result.tenant.id}), role: owner.`,
        '',
      ].join('\n'),
    );
  } finally {
    database.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`admin:create failed: ${message}\n`);
  process.exitCode = 1;
});

export { printHelp };
