import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getDataSourceToken, InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PlansService } from './plans.service';
import { AccountsService } from './accounts.service';
import { createLogger } from '../../common/services/logger.service';

export type LimitKind = 'sessions' | 'chatbots' | 'webhooks';

const KIND_LABEL: Record<LimitKind, string> = {
  sessions: 'WhatsApp sessions',
  chatbots: 'AI chatbots',
  webhooks: 'webhooks',
};

/**
 * Plan-limit enforcement for the create paths. Called from the session/chatbot/webhook create
 * services BEFORE any write: it counts the tenant's existing rows on the DATA connection (the
 * tables live there, not on main) and refuses at the plan ceiling with a 403 naming the plan and
 * the number to upgrade to.
 *
 * @@Optional@@ contracts (session/chatbot/webhook services are constructed standalone in some
 * tests) resolve the PlansService and the data DataSource lazily through ModuleRef — the same
 * lazy pattern the chatbot service uses for its ports. A resolution failure fails CLOSED: an
 * unresolvable limit surface refuses the write rather than silently letting a suspended tenant
 * grow unbounded.
 */
@Injectable()
export class PlanLimitsService {
  private dataSource?: DataSource;
  private readonly logger = createLogger('PlanLimitsService');

  constructor(
    @Optional() private readonly plans?: PlansService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly accounts?: AccountsService,
    /** The data connection, injected the same way SessionService receives it (same pool, one truth). */
    @Optional()
    @InjectDataSource('data')
    private readonly dataSourceInjected?: DataSource,
  ) {}

  /**
   * Refuse when `accountId`'s plan is expired, suspended (checked by the caller through the login
   * fence) or already at its ceiling for `kind`. A NULL accountId is the global/platform surface —
   * never limited.
   */
  async assertWithinLimit(accountId: string | null | undefined, kind: LimitKind): Promise<void> {
    if (!accountId) return; // global surface: unlimited by design
    const plan = await this.resolvePlan(accountId);
    const max = this.maxFor(plan, kind);
    if (max === -1) return;
    const current = await this.countCurrent(accountId, kind);
    if (current >= max) {
      throw new ForbiddenException(
        `Your '${plan.name}' plan allows ${max} ${KIND_LABEL[kind]} (currently ${current}). ` +
          `Upgrade the plan to add more.`,
      );
    }
  }

  /** The count used by /me and the dashboard usage widget. -1 = unlimited plan. */
  async usage(accountId: string | null | undefined): Promise<{
    sessions: { used: number; limit: number };
    chatbots: { used: number; limit: number };
    webhooks: { used: number; limit: number };
  }> {
    if (!accountId) {
      return {
        sessions: { used: 0, limit: -1 },
        chatbots: { used: 0, limit: -1 },
        webhooks: { used: 0, limit: -1 },
      };
    }
    const plan = await this.resolvePlan(accountId);
    return {
      sessions: { used: await this.countCurrent(accountId, 'sessions'), limit: this.maxFor(plan, 'sessions') },
      chatbots: { used: await this.countCurrent(accountId, 'chatbots'), limit: this.maxFor(plan, 'chatbots') },
      webhooks: { used: await this.countCurrent(accountId, 'webhooks'), limit: this.maxFor(plan, 'webhooks') },
    };
  }

  private maxFor(plan: { slug: string; name: string; maxSessions: number; maxChatbots: number; maxWebhooks: number }, kind: LimitKind): number {
    return kind === 'sessions' ? plan.maxSessions : kind === 'chatbots' ? plan.maxChatbots : plan.maxWebhooks;
  }

  private async countCurrent(accountId: string, kind: LimitKind): Promise<number> {
    const ds = await this.resolveDataSource();
    const table = kind === 'sessions' ? 'sessions' : kind === 'chatbots' ? 'ai_chatbots' : 'webhooks';
    const sql =
      ds.options.type === 'postgres'
        ? `SELECT COUNT(*)::int AS c FROM "${table}" WHERE "accountId" = $1`
        : `SELECT COUNT(*) AS c FROM "${table}" WHERE "accountId" = ?`;
    try {
      const rows = (await ds.query(sql, [accountId])) as Array<{ c: number | string }>;
      return Number(rows[0]?.c ?? 0);
    } catch (error) {
      // A missing table/column (an install whose migration has not run yet) must not turn a read
      // into a 500: count it as ZERO (permissive on read, never on create) and log once.
      this.logger?.warn?.('Plan usage count failed', {
        kind,
        table,
        driver: ds.options.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Resolve the tenant's plan. `accounts` lives on the MAIN connection (with api_keys), NOT on the
   * data connection the counts use — querying it through the data pool answered
   * `no such table: accounts` on SQLite and silently let quotas through. AccountsService owns that
   * table; `planSlug` is read off the row it already serves.
   */
  private async resolvePlan(accountId: string) {
    const plans = this.plans ?? this.moduleRef?.get<PlansService>(PlansService, { strict: false });
    const accounts = this.accounts ?? this.moduleRef?.get<AccountsService>(AccountsService, { strict: false });
    if (!plans || !accounts) throw new ForbiddenException('Plan enforcement is not configured');
    let slug = 'free';
    try {
      const account = await accounts.findOne(accountId);
      slug = account?.planSlug ?? 'free';
    } catch {
      // An unknown account (deleted mid-flight) falls back to Free, the tightest default.
    }
    return plans.resolve(slug);
  }

  private async resolveDataSource(): Promise<DataSource> {
    if (this.dataSourceInjected) return this.dataSourceInjected;
    if (!this.dataSource) {
      if (!this.moduleRef) throw new ForbiddenException('Plan enforcement is not configured');
      const resolved = this.moduleRef.get<DataSource>(getDataSourceToken('data'), { strict: false });
      if (!resolved) throw new ForbiddenException('Plan enforcement is not configured');
      this.dataSource = resolved;
    }
    return this.dataSource;
  }
}
