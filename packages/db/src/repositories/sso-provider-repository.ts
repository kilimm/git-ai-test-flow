// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { TenantRole } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { BaseRepository, TenantScopedRepository } from '../repository.js';
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

  list(): SsoProvider[] {
    return this.db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.tenantId, this.tenantId))
      .all();
  }

  findById(id: string): SsoProvider | undefined {
    return this.db
      .select()
      .from(ssoProviders)
      .where(and(eq(ssoProviders.id, id), eq(ssoProviders.tenantId, this.tenantId)))
      .get();
  }

  findByIdGlobal(id: string): SsoProvider | undefined {
    return this.db.select().from(ssoProviders).where(eq(ssoProviders.id, id)).get();
  }

  create(input: CreateSsoProviderInput): SsoProvider {
    const now = input.now ?? nowMs();

    return this.db
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
      .returning()
      .get();
  }

  update(
    id: string,
    input: {
      enabled?: boolean;
      allowedEmailDomains?: string[];
      defaultRole?: TenantRole;
      clientSecretEncrypted?: CreateSsoProviderInput['clientSecretEncrypted'];
    },
    now = nowMs(),
  ): SsoProvider | undefined {
    return this.db
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
      .returning()
      .get();
  }

  remove(id: string): boolean {
    return (
      this.db
        .delete(ssoProviders)
        .where(and(eq(ssoProviders.id, id), eq(ssoProviders.tenantId, this.tenantId)))
        .run().changes > 0
    );
  }
}

/** 公开登录入口在认证前不知道租户，只能按 providerId 全局查找。 */
export class SsoProviderGlobalRepository extends BaseRepository {
  constructor(db: AppDatabase) {
    super(db);
  }

  findById(id: string): SsoProvider | undefined {
    return this.db.select().from(ssoProviders).where(eq(ssoProviders.id, id)).get();
  }
}
