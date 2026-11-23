// 本文件所有改动要求遵循 agent-rules 规范
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, hashPassword, uuidv7 } from '@gait/config';
import type { AppEnv, SecretCipher } from '@gait/config';
import {
  AuditLogWriter,
  MembershipRepository,
  SsoIdentityRepository,
  SsoProviderGlobalRepository,
  SsoProviderRepository,
  TenantRepository,
  UserRepository,
} from '@gait/db';
import type { AppDatabase, SsoProvider } from '@gait/db';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE, MEMBER_STATUS, USER_STATUS } from '@gait/shared';
import type { TenantRole } from '@gait/shared';
import type { AuthService } from './auth-service.js';
import type { ConfigServiceDeps } from '../projects/support.js';

export const SSO_STATE_COOKIE = 'gait_sso_state';
const STATE_TTL_MS = 10 * 60_000;

export interface SsoProviderView {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  allowedEmailDomains: string[];
  defaultRole: TenantRole;
  enabled: boolean;
  createdAt: string;
}

export interface SsoPublicProvider {
  id: string;
  name: string;
}

export interface SsoCallbackResult {
  token: string;
  tenantSlug: string;
  redirectPath: string;
}

export interface SsoServiceOptions {
  db: AppDatabase;
  env: AppEnv;
  authService: AuthService;
  cipher: SecretCipher;
  deps: ConfigServiceDeps;
  auditWriter: AuditLogWriter;
}

interface StatePayload {
  providerId: string;
  nonce: string;
  redirectPath: string;
  expiresAt: number;
}

function view(provider: SsoProvider): SsoProviderView {
  return {
    id: provider.id,
    name: provider.name,
    issuer: provider.issuer,
    clientId: provider.clientId,
    allowedEmailDomains: JSON.parse(provider.allowedEmailDomainsJson) as string[],
    defaultRole: provider.defaultRole,
    enabled: provider.enabled,
    createdAt: new Date(provider.createdAt).toISOString(),
  };
}

function safeRedirect(path: string | undefined): string {
  if (path === undefined || !path.startsWith('/') || path.startsWith('//')) {
    return '/';
  }

  return path.slice(0, 500);
}

function usernameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'sso-user';

  return (
    local
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'sso-user'
  );
}

/** 通用 OIDC 登录：授权码 + userinfo，state 使用 HMAC 并绑定 Cookie 防登录 CSRF。 */
export class SsoService {
  private readonly db: AppDatabase;
  private readonly env: AppEnv;
  private readonly authService: AuthService;
  private readonly cipher: SecretCipher;
  private readonly deps: ConfigServiceDeps;
  private readonly auditWriter: AuditLogWriter;

  constructor(options: SsoServiceOptions) {
    this.db = options.db;
    this.env = options.env;
    this.authService = options.authService;
    this.cipher = options.cipher;
    this.deps = options.deps;
    this.auditWriter = options.auditWriter;
  }

  private callbackUrl(): string {
    const base = (this.env.SSO_CALLBACK_BASE_URL ?? `${this.env.PUBLIC_BASE_URL}/api/v1`).replace(
      /\/+$/,
      '',
    );

    return `${base}/auth/sso/callback`;
  }

  async listProviders(tenantSlug: string): Promise<SsoPublicProvider[]> {
    const tenant = await new TenantRepository(this.db).findBySlug(tenantSlug);

    if (tenant === undefined) {
      return [];
    }

    return (await new SsoProviderRepository(this.db, tenant.id).list())
      .filter((provider) => provider.enabled)
      .map((provider) => ({ id: provider.id, name: provider.name }));
  }

  async listAdmin(context: { tenant: { id: string } }): Promise<SsoProviderView[]> {
    return (await new SsoProviderRepository(this.db, context.tenant.id).list()).map(view);
  }

  async createProvider(
    context: { tenant: { id: string }; user: { id: string } },
    input: {
      name: string;
      issuer: string;
      clientId: string;
      clientSecret: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      userinfoEndpoint: string;
      scopes?: string[] | undefined;
      allowedEmailDomains?: string[] | undefined;
      defaultRole?: TenantRole | undefined;
    },
  ): Promise<SsoProviderView> {
    for (const url of [
      input.issuer,
      input.authorizationEndpoint,
      input.tokenEndpoint,
      input.userinfoEndpoint,
    ]) {
      this.deps.urlSafety.assertHttpUrl(url);
    }

    const id = uuidv7(this.deps.now());
    const encrypted = this.cipher.encrypt(
      context.tenant.id,
      id,
      'sso_client_secret',
      input.clientSecret,
    );
    const provider = await new SsoProviderRepository(this.db, context.tenant.id).create({
      id,
      name: input.name,
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecretEncrypted: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
      },
      authorizationEndpoint: input.authorizationEndpoint,
      tokenEndpoint: input.tokenEndpoint,
      userinfoEndpoint: input.userinfoEndpoint,
      ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
      ...(input.allowedEmailDomains === undefined
        ? {}
        : { allowedEmailDomains: input.allowedEmailDomains }),
      ...(input.defaultRole === undefined ? {} : { defaultRole: input.defaultRole }),
      now: this.deps.now(),
    });

    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.SSO_PROVIDER_CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.SSO_PROVIDER,
      resourceId: provider.id,
      detail: { name: provider.name, issuer: provider.issuer },
      now: this.deps.now(),
    });

    return view(provider);
  }

  async updateProvider(
    context: { tenant: { id: string }; user: { id: string } },
    id: string,
    input: {
      enabled?: boolean | undefined;
      allowedEmailDomains?: string[] | undefined;
      defaultRole?: TenantRole | undefined;
      clientSecret?: string | undefined;
    },
  ): Promise<SsoProviderView> {
    const repository = new SsoProviderRepository(this.db, context.tenant.id);
    const encrypted =
      input.clientSecret === undefined
        ? undefined
        : this.cipher.encrypt(context.tenant.id, id, 'sso_client_secret', input.clientSecret);
    const updated = await repository.update(
      id,
      {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.allowedEmailDomains === undefined
          ? {}
          : { allowedEmailDomains: input.allowedEmailDomains }),
        ...(input.defaultRole === undefined ? {} : { defaultRole: input.defaultRole }),
        ...(encrypted === undefined
          ? {}
          : {
              clientSecretEncrypted: {
                ciphertext: encrypted.ciphertext,
                iv: encrypted.iv,
                authTag: encrypted.authTag,
                keyVersion: encrypted.keyVersion,
              },
            }),
      },
      this.deps.now(),
    );

    if (updated === undefined) {
      throw new AppError('SSO provider not found', { status: 404, code: 'NOT_FOUND' });
    }

    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.SSO_PROVIDER_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.SSO_PROVIDER,
      resourceId: id,
      detail: { enabled: updated.enabled },
      now: this.deps.now(),
    });

    return view(updated);
  }

  async removeProvider(
    context: { tenant: { id: string }; user: { id: string } },
    id: string,
  ): Promise<void> {
    if (!(await new SsoProviderRepository(this.db, context.tenant.id).remove(id))) {
      throw new AppError('SSO provider not found', { status: 404, code: 'NOT_FOUND' });
    }

    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.SSO_PROVIDER_DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.SSO_PROVIDER,
      resourceId: id,
      detail: {},
      now: this.deps.now(),
    });
  }

  private signState(payload: StatePayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.env.SESSION_SECRET)
      .update(encoded)
      .digest('base64url');

    return `${encoded}.${signature}`;
  }

  private verifyState(state: string): StatePayload {
    const [encoded, signature] = state.split('.');

    if (encoded === undefined || signature === undefined) {
      throw new AppError('Invalid SSO state', { status: 400, code: 'SSO_STATE_INVALID' });
    }

    const expected = createHmac('sha256', this.env.SESSION_SECRET).update(encoded).digest();
    const actual = Buffer.from(signature, 'base64url');

    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new AppError('Invalid SSO state', { status: 400, code: 'SSO_STATE_INVALID' });
    }

    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload;

    if (payload.expiresAt < this.deps.now()) {
      throw new AppError('SSO state expired', { status: 400, code: 'SSO_STATE_EXPIRED' });
    }

    return payload;
  }

  async start(providerId: string, redirectPath?: string): Promise<{ url: string; state: string }> {
    const provider = await new SsoProviderGlobalRepository(this.db).findById(providerId);

    if (provider === undefined || !provider.enabled) {
      throw new AppError('SSO provider not found', { status: 404, code: 'NOT_FOUND' });
    }

    const state = this.signState({
      providerId,
      nonce: randomBytes(16).toString('base64url'),
      redirectPath: safeRedirect(redirectPath),
      expiresAt: this.deps.now() + STATE_TTL_MS,
    });
    const url = new URL(provider.authorizationEndpoint);
    const scopes = JSON.parse(provider.scopesJson) as string[];

    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', this.callbackUrl());
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);

    return { url: url.toString(), state };
  }

  async callback(input: {
    providerId: string;
    code: string;
    state: string;
    cookieState: string;
    ip: string | null;
    userAgent: string | null;
    existingToken: string | null;
  }): Promise<SsoCallbackResult> {
    if (input.state !== input.cookieState) {
      throw new AppError('SSO state mismatch', { status: 400, code: 'SSO_STATE_INVALID' });
    }

    const state = this.verifyState(input.state);

    if (state.providerId !== input.providerId) {
      throw new AppError('SSO provider mismatch', { status: 400, code: 'SSO_STATE_INVALID' });
    }

    const repository = new SsoProviderGlobalRepository(this.db);
    const provider = await repository.findById(input.providerId);

    if (provider === undefined || !provider.enabled) {
      throw new AppError('SSO provider not found', { status: 404, code: 'NOT_FOUND' });
    }

    const clientSecret = this.cipher.decrypt(provider.tenantId, provider.id, 'sso_client_secret', {
      ciphertext: provider.clientSecretCiphertext,
      iv: provider.clientSecretIv,
      authTag: provider.clientSecretAuthTag,
      keyVersion: provider.clientSecretKeyVersion,
    });
    const tokenResponse = await this.postForm(provider.tokenEndpoint, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.callbackUrl(),
      client_id: provider.clientId,
      client_secret: clientSecret,
    });
    const accessToken = tokenResponse['access_token'];

    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new AppError('OIDC token exchange failed', {
        status: 502,
        code: 'SSO_TOKEN_EXCHANGE_FAILED',
      });
    }

    const userinfoTarget = await this.deps.urlSafety.assertRequestTarget(
      provider.userinfoEndpoint,
      { httpsOnly: true },
    );
    const userinfoResponse = await this.deps.httpClient({
      method: 'GET',
      url: userinfoTarget.toString(),
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      timeoutMs: 10_000,
    });

    if (userinfoResponse.status < 200 || userinfoResponse.status >= 300) {
      throw new AppError('OIDC userinfo failed', {
        status: 502,
        code: 'SSO_USERINFO_FAILED',
      });
    }

    const userinfo = JSON.parse(userinfoResponse.bodyText) as Record<string, unknown>;
    const subject = typeof userinfo['sub'] === 'string' ? userinfo['sub'] : null;
    const email =
      typeof userinfo['email'] === 'string' ? userinfo['email'].trim().toLowerCase() : null;

    if (subject === null || email === null || !email.includes('@')) {
      throw new AppError('OIDC userinfo must contain sub and email', {
        status: 400,
        code: 'SSO_USERINFO_INVALID',
      });
    }

    if (userinfo['email_verified'] === false) {
      throw new AppError('OIDC email is not verified', {
        status: 403,
        code: 'SSO_EMAIL_NOT_VERIFIED',
      });
    }

    const allowedDomains = JSON.parse(provider.allowedEmailDomainsJson) as string[];
    const domain = email.split('@')[1] ?? '';

    if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
      throw new AppError('Email domain is not allowed', {
        status: 403,
        code: 'SSO_EMAIL_DOMAIN_FORBIDDEN',
      });
    }

    const tenant = await new TenantRepository(this.db).findById(provider.tenantId);

    if (tenant === undefined) {
      throw new AppError('SSO tenant not found', { status: 404, code: 'NOT_FOUND' });
    }

    const identities = new SsoIdentityRepository(this.db, tenant.id);
    const identity = await identities.find(provider.id, subject);
    const users = new UserRepository(this.db);
    let user =
      identity === undefined
        ? await users.findByEmail(email)
        : await users.findById(identity.userId);

    if (user === undefined) {
      const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
      let username = usernameFromEmail(email);
      let suffix = 1;

      while ((await users.findByUsername(username)) !== undefined) {
        suffix += 1;
        username = `${usernameFromEmail(email)}-${suffix}`;
      }

      user = await users.create({
        username,
        email,
        passwordHash,
        displayName:
          typeof userinfo['name'] === 'string' ? userinfo['name'].slice(0, 80) : username,
        status: USER_STATUS.ACTIVE,
        now: this.deps.now(),
      });
    }

    const memberships = new MembershipRepository(this.db, tenant.id);
    const membership = await memberships.find(user.id);

    if (membership === undefined) {
      await memberships.add({
        userId: user.id,
        role: provider.defaultRole,
        status: MEMBER_STATUS.ACTIVE,
        now: this.deps.now(),
      });
    } else if (membership.status !== MEMBER_STATUS.ACTIVE) {
      throw new AppError('Membership is not active', {
        status: 403,
        code: 'SSO_MEMBERSHIP_INACTIVE',
      });
    }

    if (identity === undefined) {
      try {
        await identities.create({
          providerId: provider.id,
          subject,
          userId: user.id,
          now: this.deps.now(),
        });
      } catch {
        // 并发回调时唯一键可能已由另一请求创建；继续使用当前用户。
      }
    } else {
      await identities.touch(provider.id, subject, this.deps.now());
    }

    const login = await this.authService.createSessionForUser(user, tenant.id, {
      ip: input.ip,
      userAgent: input.userAgent,
      existingToken: input.existingToken,
      provider: provider.name,
    });

    await this.auditWriter.append({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: AUDIT_ACTION.SSO_LOGIN,
      resourceType: AUDIT_RESOURCE_TYPE.SESSION,
      resourceId: login.session.id,
      ip: input.ip,
      userAgent: input.userAgent,
      detail: { providerId: provider.id, provider: provider.name },
      now: this.deps.now(),
    });

    return {
      token: login.token,
      tenantSlug: tenant.slug,
      redirectPath: state.redirectPath,
    };
  }

  private async postForm(
    url: string,
    fields: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const target = await this.deps.urlSafety.assertRequestTarget(url, { httpsOnly: true });
    const response = await this.deps.httpClient({
      method: 'POST',
      url: target.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
      timeoutMs: 10_000,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new AppError('OIDC token exchange failed', {
        status: 502,
        code: 'SSO_TOKEN_EXCHANGE_FAILED',
      });
    }

    return JSON.parse(response.bodyText) as Record<string, unknown>;
  }
}
