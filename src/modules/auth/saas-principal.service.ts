import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { User, UserRole } from './entities/user.entity';
import { UsersService } from './users.service';
import { SessionTokenService } from './session-token.service';

/**
 * The SaaS bearer token doubles as a wire credential: when a request carries `Authorization: Bearer
 * <saas-jwt>` instead of an API key, this service derives the token-holder's principal from their
 * LIVE database identity — never from the claims alone (a stale role or a demoted user must not
 * keep privileges for the token's remaining lifetime).
 *
 * Derivation is `HMAC(secret, "saas-v1:<userId>")`. It is deterministic per user+secret without
 * storing anything: no extra row, no revocation list — disabling the user (or rotating the secret)
 * invalidates every principal minted from their tokens immediately, because resolution always goes
 * through {@link UsersService.resolveSession}, which loads the live user row.
 *
 * The principal mimics a stored `ApiKey` (role ADMIN for account admins, OPERATOR for members) with
 * the tenant's accountId stamped in, so the existing `ApiKeyGuard` fences — account stamping on
 * creates, foreign-session refusals, plan ceilings — apply to a dashboard login unchanged. Such a
 * principal is never session-allowlisted (`allowedSessions: null`), so the dashboard may list and
 * drive every session of its tenant.
 *
 * Nothing key-like is persisted, logged or echoed to the client: the derived digest exists only in
 * process memory for the life of the request.
 */
@Injectable()
export class SaasPrincipalService {
  constructor(
    private readonly tokens: SessionTokenService,
    private readonly users: UsersService,
  ) {}

  /** True when the Authorization header is a dashboard session token rather than an `owa_k1_…` key. */
  isSessionToken(credential: string | undefined | null): boolean {
    if (!credential) return false;
    return this.tokens.verify(credential) !== null;
  }

  /**
   * Resolve a bearer JWT to the guard-shaped principal. Rejections mirror the API-key path's
   * exception shape (401) so a client cannot probe which credential kind failed.
   */
  async resolve(credential: string): Promise<{ apiKey: ApiKey; user: User }> {
    const { user } = await this.users.resolveSession(credential);
    if (!user.accountId) {
      // The platform operator has no tenant to stamp; the technical surface stays API-key based.
      throw new UnauthorizedException('Use an API key: the platform login does not authorize the technical surface');
    }
    const role =
      user.role === UserRole.ACCOUNT_ADMIN
        ? ApiKeyRole.ADMIN
        : user.role === UserRole.ACCOUNT_MEMBER
          ? ApiKeyRole.OPERATOR
          : ApiKeyRole.VIEWER;
    return { apiKey: this.principalOf(user, role), user };
  }

  /** The guard-shaped principal of one signed-in tenant user. */
  private principalOf(user: User, role: ApiKeyRole): ApiKey {
    return {
      id: `saas:${user.id}`,
      name: user.email,
      role,
      accountId: user.accountId,
      allowedSessions: null,
      allowedChats: null,
      allowedIps: null,
      expiresAt: null,
      isActive: true,
      keyHash: this.deriveFor(user.id),
      keyPrefix: `saas:${user.id.slice(0, 8)}`,
      userId: user.id,
    } as ApiKey;
  }

  /** Deterministic, per-user digest; the secret never leaves the process. */
  private deriveFor(userId: string): string {
    return createHmac('sha256', this.tokens.secretForDerivation()).update(`saas-v1:${userId}`).digest('hex');
  }
}
