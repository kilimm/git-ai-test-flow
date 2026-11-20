// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD_ENV, parseAdminCreateArgs } from '../src/cli/admin-create-args.js';

describe('parseAdminCreateArgs', () => {
  it('parses long and short flags', () => {
    expect(
      parseAdminCreateArgs([
        '--username',
        'admin',
        '-p',
        'password-1234',
        '--tenant-slug=acme',
        '--tenant-name',
        'Acme',
        '--display-name=Root',
        '--email=root@example.com',
      ]),
    ).toEqual({
      help: false,
      username: 'admin',
      password: 'password-1234',
      tenantSlug: 'acme',
      tenantName: 'Acme',
      displayName: 'Root',
      email: 'root@example.com',
    });
  });

  it('reads the password from ADMIN_PASSWORD when not passed explicitly', () => {
    const args = parseAdminCreateArgs(['--username', 'admin'], {
      env: { [ADMIN_PASSWORD_ENV]: 'env-password-123' },
    });

    expect(args.password).toBe('env-password-123');
  });

  it('prefers the explicit password over the environment', () => {
    const args = parseAdminCreateArgs(['--username', 'admin', '--password', 'cli-password-123'], {
      env: { [ADMIN_PASSWORD_ENV]: 'env-password-123' },
    });

    expect(args.password).toBe('cli-password-123');
  });

  it('supports help and rejects invalid input', () => {
    expect(parseAdminCreateArgs(['--help']).help).toBe(true);
    expect(parseAdminCreateArgs(['-h']).help).toBe(true);
    expect(() => parseAdminCreateArgs(['--unknown'])).toThrow(/Unknown argument/);
    expect(() => parseAdminCreateArgs(['--username'])).toThrow(/requires a value/);
    expect(() => parseAdminCreateArgs(['--username', '--password', 'x'])).toThrow(
      /requires a value/,
    );
  });
});
