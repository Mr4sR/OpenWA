import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AccountsService } from './accounts.service';
import { AuthService } from './auth.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from './decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { CreateAccountDto, UpdateAccountDto } from './dto/account.dto';
import { ApiKeyCreatedResponseDto, ApiKeyResponseDto, CreateApiKeyDto } from './dto/api-key.dto';

/**
 * Account (tenant) management — the multi-account surface.
 *
 * GLOBAL keys only (@RequireUnscopedKey): an account key must never mint credentials for another
 * tenant, list the tenant table, or create accounts — the same posture as API-key lifecycle. The
 * seeded master key (and every pre-accounts key, `accountId` NULL) gets through; a key bound to an
 * account is 403'd by the guard.
 *
 * A global key still passes its own role gate: creating an account (an operational namespace) is
 * OPERATOR, while key issuance inside an account and deleting the account stay ADMIN, matching the
 * existing API-key route privileges.
 */
@ApiTags('accounts')
@RequireUnscopedKey()
@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  private auditContext(req: Request, actor?: ApiKey) {
    return {
      apiKey: actor,
      ipAddress: (req as Request & { clientIp?: string }).clientIp ?? undefined,
      method: req.method,
      path: req.path,
    };
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create an account (tenant)' })
  @ApiResponse({ status: 201, description: 'Account created.' })
  @ApiResponse({ status: 400, description: 'Validation failed, or the account limit is reached.' })
  @ApiResponse({ status: 409, description: 'An account with this name already exists.' })
  async create(@Body() dto: CreateAccountDto, @Req() req: Request, @CurrentApiKey() actor?: ApiKey) {
    const account = await this.accounts.create(dto);
    await this.auditService.logInfo(AuditAction.ACCOUNT_CREATED, {
      ...this.auditContext(req, actor),
      metadata: { accountId: account.id, accountName: account.name },
    });
    return account;
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List all accounts (tenants)' })
  @ApiResponse({ status: 200, description: 'The accounts.' })
  findAll(): Promise<unknown> {
    return this.accounts.findAll();
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get one account' })
  @ApiParam({ name: 'id', description: 'Account ID' })
  @ApiResponse({ status: 200, description: 'The account.' })
  @ApiResponse({ status: 404, description: 'No such account.' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.accounts.findOne(id);
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update an account (name, note, active)' })
  @ApiParam({ name: 'id', description: 'Account ID' })
  @ApiResponse({ status: 200, description: 'Updated account.' })
  @ApiResponse({ status: 404, description: 'No such account.' })
  @ApiResponse({ status: 409, description: 'The new name is already taken.' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccountDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ) {
    const account = await this.accounts.update(id, dto);
    await this.auditService.logInfo(AuditAction.ACCOUNT_UPDATED, {
      ...this.auditContext(req, actor),
      metadata: { accountId: account.id, accountName: account.name, isActive: account.isActive },
    });
    return account;
  }

  /**
   * Issue a fresh API key FOR this account. The key inherits the requested role/ips/chats scopes;
   * its `accountId` (and nothing the caller can say) decides the tenant fence, and
   * `allowedSessions` may additionally narrow it to a subset of this account's sessions. Keys for
   * one account are listed with `?scope=keys`.
   */
  @Post(':id/api-keys')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create an API key bound to this account' })
  @ApiParam({ name: 'id', description: 'Account ID' })
  @ApiResponse({
    status: 201,
    description: 'API key created; the raw key is shown once.',
    type: ApiKeyCreatedResponseDto,
  })
  @ApiResponse({ status: 404, description: 'No such account.' })
  async createKey(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateApiKeyDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<ApiKeyCreatedResponseDto & { account: { id: string; name: string } }> {
    const account = await this.accounts.findOne(id);
    const { apiKey, rawKey } = await this.authService.createApiKey(dto, account.id);
    await this.auditService.logInfo(AuditAction.ACCOUNT_KEY_CREATED, {
      ...this.auditContext(req, actor),
      metadata: {
        accountId: account.id,
        accountName: account.name,
        targetKeyId: apiKey.id,
        targetKeyName: apiKey.name,
        role: apiKey.role,
      },
    });
    return {
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      role: apiKey.role,
      allowedIps: apiKey.allowedIps ?? undefined,
      allowedSessions: apiKey.allowedSessions ?? undefined,
      allowedChats: apiKey.allowedChats ?? undefined,
      isActive: apiKey.isActive,
      expiresAt: apiKey.expiresAt ?? undefined,
      usageCount: apiKey.usageCount,
      createdAt: apiKey.createdAt,
      apiKey: rawKey,
      account: { id: account.id, name: account.name },
    };
  }

  /** The API keys bound to this account (no raw keys — the masked rows the management page shows). */
  @Get(':id/api-keys')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List the API keys bound to this account' })
  @ApiParam({ name: 'id', description: 'Account ID' })
  @ApiResponse({ status: 200, description: 'The keys.', type: [ApiKeyResponseDto] })
  @ApiResponse({ status: 404, description: 'No such account.' })
  async listKeys(@Param('id', ParseUUIDPipe) id: string): Promise<ApiKeyResponseDto[]> {
    await this.accounts.findOne(id);
    const keys = (await this.authService.findAll()).filter(key => key.accountId === id);
    return keys.map(k => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedIps: k.allowedIps || undefined,
      allowedSessions: k.allowedSessions || undefined,
      allowedChats: k.allowedChats || undefined,
      isActive: k.isActive,
      expiresAt: k.expiresAt || undefined,
      lastUsedAt: k.lastUsedAt || undefined,
      usageCount: k.usageCount,
      createdAt: k.createdAt,
    }));
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an account that owns no sessions and no API keys' })
  @ApiParam({ name: 'id', description: 'Account ID' })
  @ApiResponse({ status: 204, description: 'Account deleted.' })
  @ApiResponse({ status: 404, description: 'No such account.' })
  @ApiResponse({ status: 409, description: 'The account still owns sessions or API keys.' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<void> {
    const account = await this.accounts.findOne(id);
    // Counts resolved SERVER-side: sessions on the data connection (AccountsService.countSessions),
    // keys on the main connection. A client-claimed count is never trusted for a destructive gate.
    const sessionCount = await this.accounts.countSessions(id);
    if (sessionCount > 0) {
      throw new ConflictException(`Account '${account.name}' still owns ${sessionCount} session(s); delete them first`);
    }
    const keyCount = (await this.authService.findAll()).filter(key => key.accountId === id).length;
    if (keyCount > 0) {
      throw new ConflictException(`Account '${account.name}' still has ${keyCount} API key(s); revoke them first`);
    }
    await this.accounts.remove(id);
    await this.auditService.logInfo(AuditAction.ACCOUNT_DELETED, {
      ...this.auditContext(req, actor),
      metadata: { accountId: account.id, accountName: account.name },
    });
  }
}
