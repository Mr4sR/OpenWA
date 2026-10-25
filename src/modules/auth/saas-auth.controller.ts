import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { UsersService } from './users.service';
import { AuthService } from './auth.service';
import { PlansService } from './plans.service';
import { PlanLimitsService } from './plan-limits.service';
import { ChangePasswordDto, LoginDto, RegisterDto } from './dto/saas-auth.dto';
import { Public } from './decorators/auth.decorators';
import { User, UserRole } from './entities/user.entity';
import { Account } from './entities/account.entity';
/**
 * The SaaS session surface: email + password login for the dashboard, issuing a JWT the SPA sends
 * as `Authorization: Bearer <token>` on every session-scoped call (`/auth/*`, `/me`). The technical
 * WhatsApp surface was, is and stays API-key based — a session proves WHO the user is; the
 * account's API key (listed on the dashboard "API Keys" page) proves what its bearer may touch on
 * the wire.
 *
 * Registration provisions the tenant in one step (account + admin binding) so a fresh sign-up has
 * a working dashboard immediately; the login fence refuses suspended accounts; every other route
 * keeps its ordinary guard.
 *
 * Every route here carries `@Public()` so the global ApiKeyGuard steps aside: the credential is the
 * JWT in the body/header, validated inside the handler (resolveSession / requirePlatformAdmin).
 * `PUBLIC_PATHS` in swagger.config.ts mirrors these for the OpenAPI document.
 */
@ApiTags('saas-auth')
@Controller('auth')
export class SaasAuthController {
  constructor(
    private readonly users: UsersService,
    private readonly plans: PlansService,
    private readonly limits: PlanLimitsService,
    private readonly authService: AuthService,
    @InjectRepository(Account, 'main')
    private readonly accounts: Repository<Account>,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Self-register: provisions a tenant + its admin and returns the session token' })
  @ApiResponse({ status: 201, description: 'Account created.' })
  @ApiResponse({ status: 400, description: 'Validation failed, or the email is already registered.' })
  async register(@Body() dto: RegisterDto) {
    const user = await this.users.register(dto);
    const account = await this.provisionAccount(user);
    // Mint the account's first API key so the tenant can call the technical surface immediately.
    const rawKey = await this.mintAccountKey(account.id, user.email);
    const session = await this.users.login(user.email, dto.password);
    return { ...session, account, apiKey: rawKey };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email + password; returns the dashboard session token' })
  @ApiResponse({ status: 200, description: 'Signed in.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials, disabled user, or suspended account.' })
  async login(@Body() dto: LoginDto) {
    return this.users.login(dto.email, dto.password);
  }

  @Public()
  @Post('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The signed-in profile with its plan and live usage counters' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Profile + plan + usage.' })
  @ApiResponse({ status: 401, description: 'No/invalid session token, disabled user or suspended account.' })
  async me(@Body() body: { token?: string }) {
    const { user } = await this.users.resolveSession(body?.token);
    if (!user.accountId) {
      // Platform admin: no tenant, no quota — the operator surface.
      return {
        user: this.profileOf(user),
        account: null,
        plan: null,
        usage: null,
      };
    }
    const account = await this.accounts.findOne({ where: { id: user.accountId } });
    if (!account) throw new BadRequestException('The account this user belongs to no longer exists');
    const plan = await this.plans.resolve(account.planSlug);
    const usage = await this.limits.usage(user.accountId);
    return {
      user: this.profileOf(user),
      account: { id: account.id, name: account.name, status: account.status, planExpiresAt: account.planExpiresAt },
      plan,
      usage,
    };
  }

  @Public()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the signed-in user password (current password required)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Password changed.' })
  @ApiResponse({ status: 400, description: 'Current password wrong, or the new one is too short or identical.' })
  async changePassword(@Body() dto: ChangePasswordDto & { token?: string }) {
    const { user } = await this.users.resolveSession(dto.token);
    await this.users.changePassword(user.id, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }

  /**
   * The API keys of the signed-in user's OWN account (JWT-authed): the dashboard needs one to make
   * the technical (X-API-Key) calls after login. A platform admin has no account — an empty list.
   */
  @Public()
  @Post('my-api-keys')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The API keys of the signed-in account (JWT-authed)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'The keys (no raw secrets).' })
  async myKeys(@Body() body: { token?: string }) {
    const { user } = await this.users.resolveSession(body?.token);
    if (!user.accountId) return [];
    return this.users.listKeysForAccount(user.accountId);
  }

  /**
   * The tenant's starter key: ADMIN inside its own account, named after the registrant, so the
   * dashboard can make X-API-Key calls right away. The raw value is returned ONCE here; the
   * dashboard stores it in sessionStorage for the tab.
   */
  private async mintAccountKey(accountId: string, email: string): Promise<string> {
    const existing = await this.users.listKeysForAccount(accountId);
    if (existing.length > 0) return ''; // a retried registration must not mint a second key
    const { rawKey } = await this.authService.createApiKey(
      { name: email.split('@')[0].slice(0, 100), role: 'admin' } as never,
      accountId,
    );
    return rawKey;
  }

  private profileOf(user: User) {
    return { id: user.id, email: user.email, name: user.name, role: user.role, accountId: user.accountId };
  }

  /**
   * One account per registration: keyed by the user id (uuid), named after the user, subscribed to
   * Free with no expiry. Idempotent on the same user id — a retried request never duplicates.
   */
  private async provisionAccount(user: User): Promise<{ id: string; name: string; planSlug: string }> {
    const existing = await this.accounts.findOne({ where: { id: user.id } });
    if (existing) return { id: existing.id, name: existing.name, planSlug: existing.planSlug };
    const account = await this.accounts.save(
      this.accounts.create({
        id: user.id,
        name: user.name || user.email.split('@')[0],
        note: 'Self-registered',
        planSlug: 'free',
        status: 'active',
        isActive: true,
      }),
    );
    await this.users.bindUserToAccount(user.id, account.id, UserRole.ACCOUNT_ADMIN);
    return { id: account.id, name: account.name, planSlug: account.planSlug };
  }
}
