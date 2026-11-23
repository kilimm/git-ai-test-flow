// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { CredentialType } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { credentials } from '../schema.js';
import type { Credential, NewCredential } from '../schema.js';

/** 密文字段集合；仓储只搬运密文，不做加解密。 */
export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export interface CreateCredentialInput {
  id?: string;
  name: string;
  type: CredentialType;
  username?: string | null;
  secret: EncryptedSecret;
  expiresAt?: number | null;
  createdByUserId?: string | null;
  now?: number;
}

export interface UpdateCredentialInput {
  name?: string;
  username?: string | null;
  expiresAt?: number | null;
  secret?: EncryptedSecret;
}

export class CredentialRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async create(input: CreateCredentialInput): Promise<Credential> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(credentials)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        name: input.name,
        type: input.type,
        username: input.username ?? null,
        secretCiphertext: input.secret.ciphertext,
        secretIv: input.secret.iv,
        secretAuthTag: input.secret.authTag,
        keyVersion: input.secret.keyVersion,
        expiresAt: input.expiresAt ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return requireRow(row);
  }

  async list(): Promise<Credential[]> {
    return this.db
      .select()
      .from(credentials)
      .where(eq(credentials.tenantId, this.tenantId))
      .orderBy(desc(credentials.createdAt), desc(credentials.id));
  }

  async findById(id: string): Promise<Credential | undefined> {
    const [row] = await this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async findByName(name: string): Promise<Credential | undefined> {
    const [row] = await this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.name, name), eq(credentials.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async update(
    id: string,
    input: UpdateCredentialInput,
    now: number = nowMs(),
  ): Promise<Credential | undefined> {
    const values: Partial<NewCredential> = { updatedAt: now };

    if (input.name !== undefined) {
      values.name = input.name;
    }

    if (input.username !== undefined) {
      values.username = input.username;
    }

    if (input.expiresAt !== undefined) {
      values.expiresAt = input.expiresAt;
    }

    if (input.secret !== undefined) {
      values.secretCiphertext = input.secret.ciphertext;
      values.secretIv = input.secret.iv;
      values.secretAuthTag = input.secret.authTag;
      values.keyVersion = input.secret.keyVersion;
    }

    const [row] = await this.db
      .update(credentials)
      .set(values)
      .where(and(eq(credentials.id, id), eq(credentials.tenantId, this.tenantId)))
      .returning();

    return row;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .delete(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.tenantId, this.tenantId)));

    return (result.rowCount ?? 0) > 0;
  }
}
