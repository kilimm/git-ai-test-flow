// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { TenantRole } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { BaseRepository, requireRow, TenantScopedRepository } from '../repository.js';
import { ssoProviders } from '../schema.js';
import type { SsoProvider } from '../schema.js';

export interface CreateSsoProviderInput {
  id?: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecretEncrypted: {
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    keyVersion: number;
  };
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  scopes?: string[];
  allowedEmailDomains?: string[];
  defaultRole?: TenantRole;
  enabled?: boolean;
  now?: number;
}

export class SsoProviderRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async list(): Promise<SsoProvider[]> {
    return this.db.select().from(ssoProviders).where(eq(ssoProviders.tenantId, this.tenantId));
  }

  async findById(id: string): Promise<SsoProvider | undefined> {
    const [row] = await this.db
      .select()
      .from(ssoProviders)
      .where(and(eq(ssoProviders.id, id), eq(ssoProviders.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async findByIdGlobal(id: string): Promise<SsoProvider | undefined> {
    const [row] = await this.db.select().from(ssoProviders).where(eq(ssoProviders.id, id)).limit(1);

    return row;
  }

  async create(input: CreateSsoProviderInput): Promise<SsoProvider> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(ssoProviders)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        name: input.name,
        issuer: input.issuer,
        clientId: input.clientId,
        clientSecretCiphertext: input.clientSecretEncrypted.ciphertext,
        clientSecretIv: input.clientSecretEncrypted.iv,
        clientSecretAuthTag: input.clientSecretEncrypted.authTag,
        clientSecretKeyVersion: input.clientSecretEncrypted.keyVersion,
        authorizationEndpoint: input.authorizationEndpoint,
        tokenEndpoint: input.tokenEndpoint,
        userinfoEndpoint: input.userinfoEndpoint,
        scopesJson: JSON.stringify(input.scopes ?? ['openid', 'email', 'profile']),
        allowedEmailDomainsJson: JSON.stringify(input.allowedEmailDomains ?? []),
        defaultRole: input.defaultRole ?? 'viewer',
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return requireRow(row);
  }

  async update(
    id: string,
    input: {
      enabled?: boolean;
      allowedEmailDomains?: string[];
      defaultRole?: TenantRole;
      clientSecretEncrypted?: CreateSsoProviderInput['clientSecretEncrypted'];
    },
    now = nowMs(),
  ): Promise<SsoProvider | undefined> {
    const [row] = await this.db
      .update(ssoProviders)
      .set({
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.allowedEmailDomains === undefined
          ? {}
          : { allowedEmailDomainsJson: JSON.stringify(input.allowedEmailDomains) }),
        ...(input.defaultRole === undefined ? {} : { defaultRole: input.defaultRole }),
        ...(input.clientSecretEncrypted === undefined
          ? {}
          : {
              clientSecretCiphertext: input.clientSecretEncrypted.ciphertext,
              clientSecretIv: input.clientSecretEncrypted.iv,
              clientSecretAuthTag: input.clientSecretEncrypted.authTag,
              clientSecretKeyVersion: input.clientSecretEncrypted.keyVersion,
            }),
        updatedAt: now,
      })
      .where(and(eq(ssoProviders.id, id), eq(ssoProviders.tenantId, this.tenantId)))
      .returning();

    return row;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .delete(ssoProviders)
      .where(and(eq(ssoProviders.id, id), eq(ssoProviders.tenantId, this.tenantId)));

    return (result.rowCount ?? 0) > 0;
  }
}

/** 公开登录入口在认证前不知道租户，只能按 providerId 全局查找。 */
export class SsoProviderGlobalRepository extends BaseRepository {
  constructor(db: AppDatabase) {
    super(db);
  }

  async findById(id: string): Promise<SsoProvider | undefined> {
    const [row] = await this.db.select().from(ssoProviders).where(eq(ssoProviders.id, id)).limit(1);

    return row;
  }
}
