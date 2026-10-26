import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { createHmac, randomBytes } from 'crypto';
import { createLogger } from '../../common/services/logger.service';
import type { UserRole } from './entities/user.entity';

/** What a dashboard token carries. `sub` is the user id (JWT convention). */
export interface SessionTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  accountId: string | null;
}

export interface IssuedSessionToken {
  token: string;
  expiresAt: number;
}

/** Default token lifetime: a working day. The dashboard re-logs in after it lapses. */
export const SESSION_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/**
 * Signs and verifies the dashboard session token (HS256 JWT).
 *
 * Secret precedence: `SAAS_JWT_SECRET` when set (32+ chars), else a random per-process secret —
 * every user is logged out on restart, which the boot banner warns about. A multi-replica
 * deployment MUST set the env or the replicas reject each other's tokens.
 */
@Injectable()
export class SessionTokenService {
  private readonly logger = createLogger('SessionTokenService');
  private readonly secret: string;
  readonly persistent: boolean;

  constructor() {
    const configured = process.env.SAAS_JWT_SECRET?.trim();
    if (configured && configured.length >= 32) {
      this.secret = configured;
      this.persistent = true;
      return;
    }
    const masterKey = process.env.API_MASTER_KEY?.trim();
    if (masterKey && masterKey.length >= 32) {
      // HKDF-SHA256 over the master key with a purpose-bound info string: deterministic per
      // deployment (persistent and replica-safe), yet cryptographically independent of every other
      // derivation from the same master key.
      this.secret = createHmac('sha256', 'openwa:saas-jwt:v1').update(masterKey).digest('base64url');
      this.persistent = true;
      if (configured) {
        this.logger.warn(
          'SAAS_JWT_SECRET is shorter than 32 characters; falling back to a secret derived from API_MASTER_KEY',
          { action: 'weak_jwt_secret' },
        );
      }
      this.logger.log('SAAS_JWT_SECRET unset: the dashboard session secret is derived from API_MASTER_KEY (persistent)');
      return;
    }
    if (configured) {
      this.logger.warn(
        'SAAS_JWT_SECRET is shorter than 32 characters and API_MASTER_KEY is unset/short; using an ephemeral secret instead',
        { action: 'weak_jwt_secret' },
      );
    }
    this.secret = randomBytes(48).toString('base64url');
    this.persistent = false;
    this.logger.warn(
      'SAAS_JWT_SECRET (32+ chars) is not set and API_MASTER_KEY cannot derive one: dashboard sessions are signed with an ephemeral secret and every user is logged out on restart. Set SAAS_JWT_SECRET, or API_MASTER_KEY (32+ chars), in production.',
      { action: 'ephemeral_jwt_secret' },
    );
  }

  /** The signing secret, exposed intentionally for services that derive a sibling MAC from it. */
  secretForDerivation(): string {
    return this.secret;
  }

  issue(payload: SessionTokenPayload): IssuedSessionToken {
    const token = jwt.sign(payload, this.secret, { algorithm: 'HS256', expiresIn: SESSION_TOKEN_TTL_SECONDS });
    return { token, expiresAt: Date.now() + SESSION_TOKEN_TTL_SECONDS * 1000 };
  }

  /** The token's claims, or null when the value is missing, malformed, forged or expired. */
  verify(token: string | undefined | null): SessionTokenPayload | null {
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof decoded !== 'object' || decoded === null) return null;
      const claims = decoded as Record<string, unknown>;
      if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
      return {
        sub: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : '',
        role: claims.role as UserRole,
        accountId: typeof claims.accountId === 'string' ? claims.accountId : null,
      };
    } catch {
      return null;
    }
  }
}
