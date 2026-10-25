import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan, PLAN_SLUG_MAX, PLAN_NAME_MAX } from './entities/plan.entity';
import { DEFAULT_PLAN_SLUGS } from './entities/plan.entity';

export interface UpsertPlanInput {
  slug: string;
  name: string;
  maxSessions: number;
  maxChatbots: number;
  maxWebhooks: number;
  priceCents: number;
  sort?: number;
  isActive?: boolean;
}

/** The plan whose limits bound a tenant. -1 = unlimited everywhere. */
export interface EffectivePlan {
  slug: string;
  name: string;
  maxSessions: number;
  maxChatbots: number;
  maxWebhooks: number;
}

/**
 * Plan CRUD + resolution. Plans live on the main connection; the LIMITS are enforced by
 * PlanLimitsService against the data connection counts. `free` can be edited but never deleted,
 * so registration always has a default to land on.
 */
@Injectable()
export class PlansService {
  constructor(
    @InjectRepository(Plan, 'main')
    private readonly repository: Repository<Plan>,
  ) {}

  findAll(): Promise<Plan[]> {
    return this.repository.find({ order: { sort: 'ASC', slug: 'ASC' } });
  }

  async findBySlug(slug: string): Promise<Plan> {
    const plan = await this.repository.findOne({ where: { slug } });
    if (!plan) throw new NotFoundException(`Plan '${slug}' not found`);
    return plan;
  }

  async create(input: UpsertPlanInput): Promise<Plan> {
    const slug = this.normalizeSlug(input.slug);
    if (await this.repository.exists({ where: { slug } })) {
      throw new BadRequestException(`Plan '${slug}' already exists`);
    }
    return this.repository.save(this.repository.create(this.normalize(input, slug)));
  }

  async update(slug: string, input: Partial<UpsertPlanInput>): Promise<Plan> {
    const plan = await this.findBySlug(slug);
    if (input.name !== undefined) plan.name = String(input.name).trim().slice(0, PLAN_NAME_MAX) || plan.name;
    if (input.maxSessions !== undefined) plan.maxSessions = this.limit(input.maxSessions);
    if (input.maxChatbots !== undefined) plan.maxChatbots = this.limit(input.maxChatbots);
    if (input.maxWebhooks !== undefined) plan.maxWebhooks = this.limit(input.maxWebhooks);
    if (input.priceCents !== undefined) plan.priceCents = Math.max(0, Math.trunc(input.priceCents));
    if (input.sort !== undefined) plan.sort = Math.trunc(input.sort);
    if (input.isActive !== undefined) plan.isActive = Boolean(input.isActive);
    return this.repository.save(plan);
  }

  /**
   * Delete a plan. `free` is permanent (registration default). A plan with subscribers is not
   * deletable — move the accounts to another plan first; deleting a subscribed plan would strand
   * tenants with no limits resolution.
   */
  async remove(slug: string): Promise<void> {
    if (DEFAULT_PLAN_SLUGS.includes(slug as (typeof DEFAULT_PLAN_SLUGS)[number])) {
      throw new BadRequestException('A stock plan cannot be deleted');
    }
    const plan = await this.findBySlug(slug);
    const subscribers = await this.repository.manager.query(`SELECT COUNT(*) AS c FROM "accounts" WHERE "planSlug" = ?`, [
      slug,
    ]);
    if (Number((subscribers as Array<{ c: number | string }>)[0]?.c ?? 0) > 0) {
      throw new BadRequestException(`Plan '${slug}' still has subscribed accounts; move them first`);
    }
    await this.repository.remove(plan);
  }

  /**
   * The effective plan for an account. Falls back to Free when the stored slug no longer resolves
   * (a plan deleted outside this service): fail-open with the tightest stock limits, never a 500.
   */
  async resolve(accountPlanSlug: string | null | undefined): Promise<EffectivePlan> {
    const plan = (await this.repository.findOne({ where: { slug: accountPlanSlug ?? 'free' } })) ??
      (await this.repository.findOne({ where: { slug: 'free' } }));
    if (!plan) {
      // The seed could not have run; degrade to Free's numbers so enforcement still works.
      return { slug: 'free', name: 'Free', maxSessions: 1, maxChatbots: 1, maxWebhooks: 1 };
    }
    return {
      slug: plan.slug,
      name: plan.name,
      maxSessions: plan.maxSessions,
      maxChatbots: plan.maxChatbots,
      maxWebhooks: plan.maxWebhooks,
    };
  }

  private normalizeSlug(slug: string): string {
    const clean = String(slug ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, PLAN_SLUG_MAX);
    if (clean.length < 2) throw new BadRequestException('Plan slug must be 2+ characters (a-z, 0-9, hyphen)');
    return clean;
  }

  private normalize(input: UpsertPlanInput, slug: string): Record<string, unknown> {
    return {
      slug,
      name: String(input.name ?? '').trim().slice(0, PLAN_NAME_MAX) || slug,
      maxSessions: this.limit(input.maxSessions),
      maxChatbots: this.limit(input.maxChatbots),
      maxWebhooks: this.limit(input.maxWebhooks),
      priceCents: Math.max(0, Math.trunc(input.priceCents ?? 0)),
      sort: Math.trunc(input.sort ?? 0),
      isActive: input.isActive ?? true,
    };
  }

  /** -1 (unlimited) or a non-negative integer. Anything else is a client error. */
  private limit(value: number): number {
    const n = Math.trunc(value);
    if (!Number.isFinite(n) || n < -1 || n > 100_000) {
      throw new BadRequestException('Limits must be -1 (unlimited) or 0..100000');
    }
    return n;
  }
}
