import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Account, ACCOUNT_NAME_MAX_LENGTH } from './entities/account.entity';
import type { CreateAccountDto, UpdateAccountDto } from './dto/account.dto';
import { createLogger } from '../../common/services/logger.service';

/** Per-deployment cap: an unbounded tenant list is an operator mistake, not a feature. */
export const ACCOUNTS_MAX = 500;

/**
 * CRUD for accounts (tenants). An account is purely a namespace: it owns sessions and API keys
 * through their `accountId` columns. Deleting one is refused while any session still belongs to
 * it — sessions carry live WhatsApp credentials and their QR directories, so an account delete
 * must never orphan them; the operator deletes the sessions first (a deliberate, visibly
 * destructive step). Keys are refused too, so no live credential outlives its tenant.
 */
@Injectable()
export class AccountsService {
  private readonly logger = createLogger('AccountsService');
  /** Data connection, resolved lazily (see countSessions); AuthModule is @Global. */
  private dataSource?: DataSource;

  constructor(
    @InjectRepository(Account, 'main')
    private readonly repository: Repository<Account>,
    private readonly moduleRef: ModuleRef,
  ) {}

  async create(dto: CreateAccountDto): Promise<Account> {
    const count = await this.repository.count();
    if (count >= ACCOUNTS_MAX) {
      throw new BadRequestException(
        `Account limit reached (${count}/${ACCOUNTS_MAX}); delete one before adding another`,
      );
    }
    const name = dto.name.trim();
    if (await this.repository.exists({ where: { name } })) {
      throw new ConflictException(`An account named '${name}' already exists`);
    }
    const saved = await this.repository.save(
      this.repository.create({ name, note: dto.note?.trim() || null, isActive: dto.isActive ?? true }),
    );
    this.logger.log(`Account created: ${saved.name}`, { accountId: saved.id, action: 'account_created' });
    return saved;
  }

  findAll(): Promise<Account[]> {
    return this.repository.find({ order: { createdAt: 'ASC', id: 'ASC' } });
  }

  async findOne(id: string): Promise<Account> {
    const account = await this.repository.findOne({ where: { id } });
    if (!account) throw new NotFoundException(`Account ${id} not found`);
    return account;
  }

  async update(id: string, dto: UpdateAccountDto): Promise<Account> {
    const account = await this.findOne(id);
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== account.name && (await this.repository.exists({ where: { name } }))) {
        throw new ConflictException(`An account named '${name}' already exists`);
      }
      account.name = name.slice(0, ACCOUNT_NAME_MAX_LENGTH);
    }
    if (dto.note !== undefined) account.note = dto.note?.trim() || null;
    if (dto.isActive !== undefined) account.isActive = dto.isActive;
    return this.repository.save(account);
  }

  /**
   * How many sessions belong to an account. Sessions live on the DATA connection, resolved lazily
   * through ModuleRef because AuthModule is @Global and imported by SessionModule (a constructor
   * dependency would close the cycle). A data connection that cannot be read propagates: deleting
   * an account is destructive, so an unknown session count must refuse, never delete.
   */
  async countSessions(accountId: string): Promise<number> {
    if (!this.dataSource) {
      this.dataSource = this.moduleRef.get<DataSource>(getDataSourceToken('data'), { strict: false });
    }
    const sql =
      this.dataSource.options.type === 'postgres'
        ? `SELECT COUNT(*)::int AS "count" FROM "sessions" WHERE "accountId" = $1`
        : `SELECT COUNT(*) AS "count" FROM "sessions" WHERE "accountId" = ?`;
    const rows = await this.dataSource.query<Array<{ count: number | string }>>(sql, [accountId]);
    return Number(rows[0]?.count ?? 0);
  }

  /** Delete an account; the caller has already refused one that still owns sessions or keys. */
  async remove(id: string): Promise<void> {
    const account = await this.findOne(id);
    await this.repository.remove(account);
    this.logger.log(`Account deleted: ${account.name}`, { accountId: id, action: 'account_deleted' });
  }
}
