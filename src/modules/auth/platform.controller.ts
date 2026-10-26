import {
  BadRequestException,
  Body,
  ConflictException,
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
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountsService } from './accounts.service';
import { PlansService } from './plans.service';
import { UsersService } from './users.service';
import { SessionTokenService } from './session-token.service';
import { Account } from './entities/account.entity';
import { User, UserRole } from './entities/user.entity';
import type { UpsertPlanInput } from './plans.service';
import { CreateAccountDto, UpdateAccountDto } from './dto/account.dto';
import { Public } from './decorators/auth.decorators';

/**
 * The DEVELOPER (platform) surface: everything an operator of the SaaS needs and a tenant must
 * never see — every account, every user, the plan catalogue, suspension.
 *
 * Auth model: every route takes `token` (body or `?token=`) and resolves it through
 * SessionTokenService + UsersService; anything that is not an ACTIVE platform admin is a 403.
 * A dedicated guard cannot be used because the platform surface lives on the same gateway as the
 * API-key routes, and its callers are browsers that authenticate with the JWT, never with a key.
 */
@ApiTags('platform')
@Public()
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly plans: PlansService,
    private readonly users: UsersService,
    private readonly tokens: SessionTokenService,
    @InjectRepository(Account, 'main')
    private readonly accountsRepository: Repository<Account>,
  ) {}

  /** 403 unless the token names an active platform admin. Audited by the callers' catch blocks. */
  private async requirePlatformAdmin(token: string | undefined): Promise<User> {
    const { user } = await this.users.resolveSession(token);
    if (user.role !== UserRole.PLATFORM_ADMIN) {
      throw new ForbiddenException('Platform access requires a platform admin login');
    }
    return user;
  }

  private tokenFrom(token: string | undefined, queryToken: string | undefined): string | undefined {
    return token || queryToken;
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  @Get('accounts')
  @ApiOperation({ summary: 'Every account with its plan, status and user count' })
  async listAccounts(@Query('token') token?: string) {
    await this.requirePlatformAdmin(this.tokenFrom(undefined, token));
    const accounts = await this.accounts.findAll();
    const users = await this.users.findAll();
    return accounts.map(account => {
      const members = users.filter(u => u.accountId === account.id);
      return {
        id: account.id,
        name: account.name,
        note: account.note,
        planSlug: account.planSlug,
        status: account.status,
        planExpiresAt: account.planExpiresAt,
        isActive: account.isActive,
        createdAt: account.createdAt,
        userCount: members.length,
        users: members.map(u => ({ id: u.id, email: u.email, name: u.name, isActive: u.isActive })),
      };
    });
  }

  @Post('accounts')
  @ApiOperation({ summary: 'Create an account (developer-side provisioning)' })
  async createAccount(@Body() dto: CreateAccountDto, @Query('token') token?: string) {
    await this.requirePlatformAdmin(this.tokenFrom(undefined, token));
    return this.accounts.create(dto);
  }

  @Put('accounts/:id')
  @ApiOperation({ summary: 'Update an account (name, note, active)' })
  @ApiParam({ name: 'id', description: 'Account ID' })
  async updateAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccountDto,
    @Query('token') token?: string,
  ) {
    await this.requirePlatformAdmin(this.tokenFrom(undefined, token));
    return this.accounts.update(id, dto);
  }

  @Delete('accounts/:id')
  @ApiOperation({ summary: 'Delete an account with no sessions and no users' })
  async deleteAccount(@Param('id', ParseUUIDPipe) id: string, @Query('token') token?: string) {
    await this.requirePlatformAdmin(this.tokenFrom(undefined, token));
    const sessionCount = await this.accounts.countSessions(id);
    if (sessionCount > 0) throw new ConflictException('Account still owns sessions; delete them first');
    const members = (await this.users.findAll()).filter(candidate => candidate.accountId === id);
    if (members.length > 0) throw new ConflictException('Account still has users; delete or reassign them first');
    await this.accounts.remove(id);
    return { ok: true };
  }

  /** The suspension switch: a suspended tenant cannot log in and its keys 401. */
  @Put('accounts/:id/status')
  @ApiOperation({ summary: 'Suspend or reactivate an account' })
  async setAccountStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { token?: string; status?: 'active' | 'suspended' },
  ) {
    await this.requirePlatformAdmin(this.tokenFrom(body?.token, undefined));
    const status = body?.status === 'suspended' ? 'suspended' : 'active';
    const account = await this.accounts.update(id, { isActive: status === 'active' });
    await this.accountsRepository.update({ id }, { status });
    return { ok: true, status: account.isActive ? 'active' : 'suspended' };
  }

  // ── Plans ─────────────────────────────────────────────────────────────────

  @Get('plans')
  @ApiOperation({ summary: 'The plan catalogue with subscriber counts' })
  async listPlans(@Query('token') token?: string) {
    await this.requirePlatformAdmin(this.tokenFrom(undefined, token));
    const plans = await this.plans.findAll();
    const accounts = await this.accountsRepository.find();
    return plans.map(plan => ({
      ...plan,
      subscribers: accounts.filter(account => account.planSlug === plan.slug).length,
    }));
  }

  @Post('plans')
  @ApiOperation({ summary: 'Create a plan' })
  async createPlan(@Body() body: { token?: string } & UpsertPlanInput) {
    await this.requirePlatformAdmin(this.tokenFrom(body?.token, undefined));
    return this.plans.create({
      slug: body?.slug ?? '',
      name: body?.name ?? '',
      maxSessions: Number(body?.maxSessions ?? 1),
      maxConcurrentSessions: Number(body?.maxConcurrentSessions ?? 1),
      maxChatbots: Number(body?.maxChatbots ?? 0),
      maxWebhooks: Number(body?.maxWebhooks ?? 0),
      priceCents: Number(body?.priceCents ?? 0),
      sort: body?.sort,
      isActive: body?.isActive,
    });
  }

  @Put('plans/:slug')
  @ApiOperation({ summary: 'Update a plan (limits, price, active)' })
  async updatePlan(@Param('slug') slug: string, @Body() body: Partial<UpsertPlanInput> & { token?: string }) {
    await this.requirePlatformAdmin(this.tokenFrom(body?.token, undefined));
    return this.plans.update(slug, body);
  }

  @Delete('plans/:slug')
  @ApiOperation({ summary: 'Delete a plan (not a stock one, no subscribers)' })
  async deletePlan(@Param('slug') slug: string, @Query('token') token?: string) {
    await this.requirePlatformAdmin(this.tokenFrom(undefined, token));
    await this.plans.remove(slug);
    return { ok: true };
  }

  /** Change an account's plan. Invalidates nothing: the new limits apply on the next create. */
  @Put('accounts/:id/plan')
  @ApiOperation({ summary: 'Subscribe an account to a plan (or extend it)' })
  async setAccountPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { token?: string; planSlug?: string; planExpiresAt?: string | null },
  ) {
    await this.requirePlatformAdmin(this.tokenFrom(body?.token, undefined));
    await this.plans.findBySlug(body?.planSlug ?? '');
    const account = await this.accountsRepository.findOne({ where: { id } });
    if (!account) throw new BadRequestException('No such account');
    account.planSlug = body?.planSlug ?? account.planSlug;
    const expiry = body?.planExpiresAt;
    account.planExpiresAt = expiry === null || expiry === undefined ? null : new Date(expiry);
    if (!account.planStartedAt) account.planStartedAt = new Date();
    return this.accountsRepository.save(account);
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  @Get('users')
  @ApiOperation({ summary: 'Every login across accounts' })
  async listUsers(@Query('token') token?: string) {
    await this.requirePlatformAdmin(this.tokenFrom(undefined, token));
    const users = await this.users.findAll();
    return users.map(user => this.userView(user));
  }

  @Put('users/:id/active')
  @ApiOperation({ summary: 'Enable or disable a login (keep at least one active platform admin)' })
  async setUserActive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { token?: string; isActive?: boolean },
  ) {
    const actor = await this.requirePlatformAdmin(this.tokenFrom(body?.token, undefined));
    if (id === actor.id && body?.isActive === false) {
      throw new BadRequestException('A platform admin cannot disable their own login here');
    }
    const user = await this.users.setActive(id, Boolean(body?.isActive));
    return this.userView(user);
  }

  @Put('users/:id/account')
  @ApiOperation({ summary: 'Move a login to an account (or detach: null)' })
  async setUserAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { token?: string; accountId?: string | null },
  ) {
    await this.requirePlatformAdmin(this.tokenFrom(body?.token, undefined));
    const target = body?.accountId ?? null;
    if (target) {
      const account = await this.accountsRepository.findOne({ where: { id: target } });
      if (!account) throw new BadRequestException('No such account');
    }
    const user = await this.users.setAccount(id, target);
    return this.userView(user);
  }

  private userView(user: User) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      accountId: user.accountId,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }
}
