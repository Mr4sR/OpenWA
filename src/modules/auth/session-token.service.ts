import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
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
 * The secret precedence mirrors the API master key: `SAAS_JWT_SECRET` when set (multi-replica
 * deployments MUST set it, or each replica would reject the others' tokens), otherwise a random
 * per-process secret generated at boot. The generated fallback is logged at boot
 * (`tokenPersistence` warning) because it logs every user out on restart.
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
    } else {
      if (configured) {
        this.logger.warn('SAAS_JWT_SECRET is shorter than 32 characters; using an ephemeral secret instead', {
          action: 'weak_jwt_secret',
        });
      }
      this.secret = randomBytes(48).toString('base64url');
      this.persistent = false;
      this.logger.warn(
        'SAAS_JWT_SECRET is not set: dashboard sessions are signed with an ephemeral secret and every user is logged out on restart. Set a 32+ character secret in production.',
        { action: 'ephemeral_jwt_secret' },
      );
    }
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
      const sub = claims.sub;
      if (typeof sub !== 'string' || sub.length === 0) return null;
      return {
        sub,
        email: typeof claims.email === 'string' ? claims.email : '',
        role: claims.role as UserRole,
        accountId: typeof claims.accountId === 'string' ? claims.accountId : null,
      };
    } catch {
      return null;
    }
  }
}
