import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { UsersService } from './users.service';
import { AuthService } from './auth.service';
import { PlansService } from './plans.service';
import { PlanLimitsService } from './plan-limits.service';
import {
  ChangePasswordDto,
  CreateMemberDto,
  LoginDto,
  RegisterDto,
  SessionTokenBodyDto,
  UpdateMemberDto,
} from './dto/saas-auth.dto';
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
    const session = await this.users.login(dto.email, dto.password);
    // Credential recovery: a tenant whose key was lost has no usable technical surface and no way
    // to mint one through it. When the account has NO key at all, mint one here (idempotent, the
    // register mintAccountKey rule) and return the raw value ONCE with this login response. An
    // EXISTING key is NEVER re-exposed: its raw value is unrecoverable by design (only the hash is
    // stored), so `apiKey` rides only on the one login that minted it; every other login answers
    // the bare session. A platform admin (accountId NULL) never mints.
    const rawKey = session.user.accountId ? await this.mintAccountKey(session.user.accountId, session.user.email) : '';
    return rawKey ? { ...session, apiKey: rawKey } : session;
  }

  /**
   * Rotate the signed-in user's account API key. POST not PUT: every call RETIRES the previous
   * key(s) of the account (a rotation, not a create — the old value must stop working the moment a
   * replacement is issued) and returns the fresh raw value ONCE. This is the SaaS recovery path:
   * keys are stored hashed and /auth/my-api-keys only lists masked rows, so a lost key would
   * otherwise be unrecoverable without platform-operator intervention.
   *
   * The key is always ACCOUNT-scoped and ADMIN-role (the same authority as the registrant's starter
   * key), named `<email> (dashboard)`. A platform admin has no account and is refused.
   */
  @Public()
  @Post('account-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the account API key for the signed-in admin; the raw value is returned once' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'The new raw key (shown once) and its masked row.' })
  @ApiResponse({ status: 400, description: 'A platform admin has no account key to rotate.' })
  @ApiResponse({ status: 403, description: 'Only an account admin may rotate the account key.' })
  @ApiResponse({ status: 401, description: 'No/invalid session token, disabled user or suspended account.' })
  async rotateAccountKey(@Body() body: SessionTokenBodyDto) {
    const user = await this.requireAccountAdmin(body?.token);
    if (!user.accountId) throw new BadRequestException('A platform admin has no account key to rotate');
    // Retire every existing key of the account so a leaked value dies with its replacement.
    for (const key of await this.users.listKeysForAccount(user.accountId)) {
      await this.authService.delete(String(key.id));
    }
    const { apiKey, rawKey } = await this.createAccountKeyFor(
      user.accountId,
      `${user.email} (dashboard)`,
      'admin',
      user.id,
    );
    return { apiKey: rawKey, key: this.keyRowView(apiKey) };
  }

  // ── Member management (account admins over their own account) ─────────────

  /** The members of the signed-in admin's OWN account. Never the platform surface. */
  @Public()
  @Get('members')
  @ApiOperation({ summary: 'List the members of the signed-in account (account admins only)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'The users of the account (no credentials).' })
  @ApiResponse({ status: 403, description: 'Only an account admin may manage members.' })
  async listMembers(@Body() body: SessionTokenBodyDto) {
    const requester = await this.requireAccountAdmin(body?.token);
    const members = await this.users.listForAccount(requester.accountId as string);
    return members.map(member => this.memberView(member));
  }

  /**
   * Invite a member into the signed-in admin's OWN account. The account id comes from the caller's
   * session, never from the request body — an account admin can never create a user in another
   * account. The new member gets a VIEWER-role account key (returned once) so it can read the
   * tenant's data immediately.
   */
  @Public()
  @Post('members')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a member of the signed-in account (account admins only)' })
  @ApiResponse({ status: 201, description: 'Member created; its raw API key is returned once.' })
  @ApiResponse({ status: 400, description: 'Validation failed, or the email is already registered.' })
  @ApiResponse({ status: 403, description: 'Only an account admin may manage members.' })
  async createMember(@Body() body: CreateMemberDto & SessionTokenBodyDto) {
    const requester = await this.requireAccountAdmin(body?.token);
    const accountId = requester.accountId as string;
    const member = await this.users.createMemberForAccount(accountId, {
      email: body.email,
      password: body.password,
      name: body.name,
      role: UserRole.ACCOUNT_MEMBER,
    });
    // Starter key for the member, VIEWER inside this account (read-only). Returned exactly once.
    const { apiKey: keyRow, rawKey } = await this.createAccountKeyFor(
      accountId,
      `${member.email.split('@')[0].slice(0, 88)} (member)`,
      'viewer',
      member.id,
    );
    return { ...this.memberView(member), apiKey: rawKey, key: this.keyRowView(keyRow) };
  }

  /** Enable or disable a member login of the signed-in admin's OWN account. */
  @Public()
  @Put('members/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable or disable a member of the signed-in account (account admins only)' })
  @ApiParam({ name: 'id', description: 'User id' })
  @ApiResponse({ status: 200, description: 'The updated member.' })
  @ApiResponse({ status: 400, description: 'No isActive given, or the last active admin would be disabled.' })
  @ApiResponse({ status: 403, description: 'Only an account admin may manage members.' })
  @ApiResponse({ status: 404, description: 'No such member in this account.' })
  async updateMember(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateMemberDto & SessionTokenBodyDto) {
    const requester = await this.requireAccountAdmin(body?.token);
    if (typeof body?.isActive !== 'boolean') {
      throw new BadRequestException('isActive (boolean) is required');
    }
    const member = await this.users.setMemberActive(id, requester.accountId as string, body.isActive);
    return this.memberView(member);
  }

  /** Remove a member of the signed-in admin's OWN account. */
  @Public()
  @Delete('members/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a member of the signed-in account (account admins only)' })
  @ApiParam({ name: 'id', description: 'User id' })
  @ApiResponse({ status: 200, description: 'Member removed.' })
  @ApiResponse({ status: 403, description: 'Only an account admin may manage members.' })
  @ApiResponse({ status: 404, description: 'No such member in this account.' })
  async deleteMember(@Param('id', ParseUUIDPipe) id: string, @Body() body: SessionTokenBodyDto) {
    const requester = await this.requireAccountAdmin(body?.token);
    if (id === requester.id) {
      // Removing one's own admin login would lock the tenant out of member management entirely.
      throw new BadRequestException('An account admin cannot remove their own login');
    }
    await this.users.removeMember(id, requester.accountId as string);
    return { ok: true };
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

  /**
   * The account gate for the account-scoped routes here: the caller must be a LIVE tenant login
   * (accountId set) holding the account-admin role. A platform admin (accountId NULL) is a 403 —
   * the platform surface is /platform/*, not the tenant dashboard. The fence is the caller's OWN
   * accountId, resolved from the JWT against the live user row, never from the request body, so
   * an account admin can never address another account.
   */
  private async requireAccountAdmin(token: string | undefined): Promise<User> {
    const { user } = await this.users.resolveSession(token);
    if (!user.accountId || user.role !== UserRole.ACCOUNT_ADMIN) {
      throw new ForbiddenException('Only an account admin may manage this account');
    }
    return user;
  }

  /** Mint one account-scoped key of the given role; attribution records the minting login. */
  private async createAccountKeyFor(accountId: string, name: string, role: 'admin' | 'viewer', userId: string) {
    const created = await this.authService.createApiKey({ name: name.slice(0, 100), role } as never, accountId);
    // Attribution only: the tenant fence stays on accountId (see the ApiKey entity). A starter key
    // minted before any user existed (the login path) carries no userId.
    const apiKey = userId ? ((await this.users.attachKeyToUser(created.apiKey.id, userId)) as never) : created.apiKey;
    return { apiKey, rawKey: created.rawKey };
  }

  private keyRowView(key: {
    id: string;
    name: string;
    keyPrefix: string;
    role: string;
    accountId: string | null;
    isActive: boolean;
    createdAt: Date;
  }) {
    return {
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      role: key.role,
      accountId: key.accountId,
      isActive: key.isActive,
      createdAt: key.createdAt,
    };
  }

  private memberView(user: User) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
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
