import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { SessionTokenService, type SessionTokenPayload } from './session-token.service';
import { User, UserRole, USER_EMAIL_MAX_LENGTH, USER_NAME_MAX_LENGTH } from './entities/user.entity';
import { Plan } from './entities/plan.entity';
import { hashPassword, needsRehash, verifyPassword, PASSWORD_MIN_LENGTH } from './password-hash';
import { createLogger } from '../../common/services/logger.service';
/** Per-deployment cap on user logins (a runaway script is an operator mistake, not a feature). */
export const USERS_MAX = 5000;

export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
}

export interface LoginResult {
  token: string;
  expiresAt: number;
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    accountId: string | null;
  };
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * SaaS login identities. Registration is public and ALWAYS creates an ordinary tenant
 * (`account_admin` with accountId NULL until provisioning binds one); the platform operator role is
 * never self-assignable — it exists only through the bootstrap admin (`ensurePlatformAdmin`).
 */
@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = createLogger('UsersService');

  /**
   * Boot-time guarantee that a platform admin login exists, so a fresh SaaS install is reachable
   * through the dashboard. Runs here (not in AuthService) because it needs this service's own
   * repositories, which are ready by now. The generated password is printed ONCE and written to
   * `data/.saas-admin-password` (0600) so an operator can retrieve it without the log pipeline.
   */
  async onModuleInit(): Promise<void> {
    try {
      const result = await this.ensurePlatformAdmin();
      if (result.created && result.password) {
        try {
          const file = join(process.cwd(), 'data', '.saas-admin-password');
          writeFileSync(file, `${result.email}\n${result.password}\n`, { mode: 0o600 });
        } catch {
          /* best-effort; the banner below is enough */
        }
        this.logger.log('──────────── SAAS PLATFORM ADMIN ────────────');
        this.logger.log(`  Email   : ${result.email}`);
        this.logger.log(`  Password: ${result.password}`);
        this.logger.log('  Sign in at /login, then change the password from Account.');
        this.logger.log('─────────────────────────────────────────────');
      }
    } catch (error) {
      this.logger.warn('Could not provision the platform admin login', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  constructor(
    @InjectRepository(User, 'main')
    private readonly repository: Repository<User>,
    @InjectRepository(Plan, 'main')
    private readonly plans: Repository<Plan>,
    private readonly tokens: SessionTokenService,
  ) {}

  /**
   * Guarantees a platform admin exists so a fresh install is never locked out with no SaaS login.
   *
   * Bootstrap precedence: `SAAS_ADMIN_EMAIL` + `SAAS_ADMIN_PASSWORD` when both are set (idempotent —
   * an existing row with that email is left untouched); otherwise, when NO user exists at all, a
   * generated `admin@openwa.local` account whose password is printed ONCE at boot (and written to
   * `data/.saas-admin-password`, 0600), mirroring how the API master key is surfaced today.
   */
  async ensurePlatformAdmin(): Promise<{ created: boolean; email: string; password?: string }> {
    const configuredEmail = process.env.SAAS_ADMIN_EMAIL?.trim().toLowerCase();
    const configuredPassword = process.env.SAAS_ADMIN_PASSWORD ?? '';

    if (configuredEmail && configuredPassword) {
      if (await this.repository.exists({ where: { email: configuredEmail } })) {
        return { created: false, email: configuredEmail };
      }
      await this.repository.save(
        this.repository.create({
          email: configuredEmail,
          name: 'Platform Admin',
          passwordHash: await hashPassword(configuredPassword),
          role: UserRole.PLATFORM_ADMIN,
          accountId: null,
          isActive: true,
        }),
      );
      this.logger.log('Platform admin provisioned from SAAS_ADMIN_EMAIL', { email: configuredEmail });
      return { created: true, email: configuredEmail };
    }

    const anyPlatformAdmin = await this.repository.exists({ where: { role: UserRole.PLATFORM_ADMIN } });
    if (anyPlatformAdmin) return { created: false, email: '(existing platform admin)' };

    const email = 'admin@openwa.local';
    const existing = await this.repository.findOne({ where: { email } });
    if (existing) return { created: false, email };

    const password = this.generatePassword();
    await this.repository.save(
      this.repository.create({
        email,
        name: 'Platform Admin',
        passwordHash: await hashPassword(password),
        role: UserRole.PLATFORM_ADMIN,
        accountId: null,
        isActive: true,
      }),
    );
    this.logger.log('Generated a platform admin login (change the password from Settings)', { email });
    return { created: true, email, password };
  }

  private generatePassword(): string {
    // 24 base64url chars ≈ 144 bits — readable enough to copy once, far beyond brute force.
    return randomBytes(18).toString('base64url');
  }

  /** Public self-registration: a new tenant admin. Bounded by USERS_MAX. */
  async register(input: RegisterInput): Promise<User> {
    const email = normalizeEmail(input.email ?? '');
    if (!EMAIL_PATTERN.test(email) || email.length > USER_EMAIL_MAX_LENGTH) {
      throw new BadRequestException('A valid email address is required');
    }
    if (typeof input.password !== 'string' || input.password.length < PASSWORD_MIN_LENGTH) {
      throw new BadRequestException(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }
    const count = await this.repository.count();
    if (count >= USERS_MAX) {
      throw new BadRequestException('Registration is currently closed');
    }
    if (await this.repository.exists({ where: { email } })) {
      throw new BadRequestException('An account with this email already exists');
    }
    const name = (input.name?.trim() || email.split('@')[0]).slice(0, USER_NAME_MAX_LENGTH);
    const user = await this.repository.save(
      this.repository.create({
        email,
        name,
        passwordHash: await hashPassword(input.password),
        role: UserRole.ACCOUNT_ADMIN,
        accountId: null,
        isActive: true,
      }),
    );
    this.logger.log('User registered', { userId: user.id, email });
    return user;
  }

  /**
   * Login. One message for every rejection of an EXISTING email (wrong password, disabled user,
   * suspended tenant) so the form never reveals whether an address is registered; a missing email
   * still costs one hash verification below to keep the timing flat.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const normalized = normalizeEmail(email ?? '');
    const user = await this.repository.findOne({ where: { email: normalized } });
    const matches = await verifyPassword(password ?? '', user?.passwordHash);
    if (!user || !matches) throw new UnauthorizedException('Invalid email or password');
    if (!user.isActive) throw new UnauthorizedException('Invalid email or password');

    // A suspended tenant locks every login in it out (the platform admin can lift it).
    if (user.accountId) {
      const account = await this.accountStatus(user.accountId);
      if (account === 'suspended') throw new UnauthorizedException('This account is suspended');
    }

    // Opportunistic cost upgrade: a row hashed with older parameters is rewritten on first login.
    if (needsRehash(user.passwordHash)) {
      user.passwordHash = await hashPassword(password);
    }
    user.lastLoginAt = new Date();
    await this.repository.save(user);

    const { token, expiresAt } = this.tokens.issue({
      sub: user.id,
      email: user.email,
      role: user.role,
      accountId: user.accountId,
    });
    return {
      token,
      expiresAt,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, accountId: user.accountId },
    };
  }

  /** Resolve a bearer token to the LIVE user (a deleted/disabled user invalidates its old token). */
  async resolveSession(token: string | undefined | null): Promise<{ user: User; claims: SessionTokenPayload }> {
    const claims = this.tokens.verify(token);
    if (!claims) throw new UnauthorizedException('Session expired or invalid; sign in again');
    const user = await this.repository.findOne({ where: { id: claims.sub } });
    if (!user || !user.isActive) throw new UnauthorizedException('Session expired or invalid; sign in again');
    if (user.accountId) {
      const account = await this.accountStatus(user.accountId);
      if (account === 'suspended') throw new UnauthorizedException('This account is suspended');
    }
    return { user, claims };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.repository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!(await verifyPassword(currentPassword ?? '', user.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LENGTH) {
      throw new BadRequestException(`New password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }
    if (newPassword === currentPassword) {
      throw new BadRequestException('The new password must differ from the current one');
    }
    user.passwordHash = await hashPassword(newPassword);
    await this.repository.save(user);
  }

  async findById(id: string): Promise<User> {
    const user = await this.repository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async listForAccount(accountId: string): Promise<User[]> {
    return this.repository.find({ where: { accountId }, order: { createdAt: 'ASC', id: 'ASC' } });
  }

  /** API keys bound to an account (masked rows), read through the main connection. */
  async listKeysForAccount(accountId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.repository.manager.query(
      `SELECT "id","name","keyPrefix","role","accountId","isActive" FROM "api_keys" WHERE "accountId" = ? AND "isActive" = 1`,
      [accountId],
    )) as Array<Record<string, unknown>>;
  }

  findAll(): Promise<User[]> {
    return this.repository.find({ order: { createdAt: 'DESC' } });
  }

  /** Platform-admin action: enable/disable a login (a disabled user cannot sign in). */
  async setActive(id: string, isActive: boolean): Promise<User> {
    const user = await this.findById(id);
    if (user.role === UserRole.PLATFORM_ADMIN && !isActive) {
      const others = (await this.repository.find({ where: { role: UserRole.PLATFORM_ADMIN, isActive: true } })).filter(
        candidate => candidate.id !== user.id,
      );
      if (others.length === 0) throw new ForbiddenException('At least one active platform admin must remain');
    }
    user.isActive = isActive;
    return this.repository.save(user);
  }

  /** Bind a user to its tenant and stamp the admin role (registration provisioning). */
  async bindUserToAccount(userId: string, accountId: string, role: UserRole = UserRole.ACCOUNT_ADMIN): Promise<User> {
    const user = await this.findById(userId);
    if (user.role === UserRole.PLATFORM_ADMIN) {
      throw new BadRequestException('A platform admin cannot be bound to an account');
    }
    user.accountId = accountId;
    user.role = role;
    return this.repository.save(user);
  }


  /** Bind/unbind a tenant login. Binding a platform admin to an account is refused. */
  async setAccount(id: string, accountId: string | null): Promise<User> {
    const user = await this.findById(id);
    if (user.role === UserRole.PLATFORM_ADMIN && accountId) {
      throw new BadRequestException('A platform admin cannot be bound to an account');
    }
    user.accountId = accountId;
    return this.repository.save(user);
  }

  /**
   * A tenant admin may invite a member into its OWN account. The account id comes from the caller's
   * session, never from the request body.
   */
  async createMemberForAccount(accountId: string, input: RegisterInput & { role?: UserRole }): Promise<User> {
    const email = normalizeEmail(input.email ?? '');
    if (!EMAIL_PATTERN.test(email) || email.length > USER_EMAIL_MAX_LENGTH) {
      throw new BadRequestException('A valid email address is required');
    }
    if (typeof input.password !== 'string' || input.password.length < PASSWORD_MIN_LENGTH) {
      throw new BadRequestException(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }
    if (await this.repository.exists({ where: { email } })) {
      throw new BadRequestException('An account with this email already exists');
    }
    const role = input.role === UserRole.ACCOUNT_ADMIN ? UserRole.ACCOUNT_ADMIN : UserRole.ACCOUNT_MEMBER;
    return this.repository.save(
      this.repository.create({
        email,
        name: (input.name?.trim() || email.split('@')[0]).slice(0, USER_NAME_MAX_LENGTH),
        passwordHash: await hashPassword(input.password),
        role,
        accountId,
        isActive: true,
      }),
    );
  }

  /** 'active' | 'suspended' | 'missing'. A missing account fails CLOSED (suspended). */
  private async accountStatus(accountId: string): Promise<'active' | 'suspended' | 'missing'> {
    const set = (await this.repository.manager.query(
      `SELECT "status" FROM "accounts" WHERE "id" = ?`,
      [accountId],
    )) as Array<{ status: string }>;
    if (set.length === 0) return 'missing';
    return set[0].status === 'suspended' ? 'suspended' : 'active';
  }
}
