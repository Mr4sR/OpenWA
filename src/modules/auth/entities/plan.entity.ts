import { Entity, Column, CreateDateColumn, UpdateDateColumn, Index, PrimaryGeneratedColumn } from 'typeorm';

export const PLAN_SLUG_MAX = 30;
export const PLAN_NAME_MAX = 60;

/** The four stock plans. Platform admin may add more; FREE is never deletable (registration default). */
export const DEFAULT_PLAN_SLUGS = ['free', 'starter', 'pro', 'business'] as const;

/**
 * A SaaS tariff. Limits bound what an account of this plan may create: the enforcement sites are
 * the session/chatbot/webhook create paths (see plan-limits.service.ts), not a promise the runtime
 * proactively throttles.
 */
@Entity('plans')
@Index('UQ_plans_slug', ['slug'], { unique: true })
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** URL-safe identity ('free', 'starter', …). Immutable after create; sort/default pivot. */
  @Column({ type: 'varchar', length: PLAN_SLUG_MAX })
  slug!: string;

  @Column({ type: 'varchar', length: PLAN_NAME_MAX })
  name!: string;

  /** -1 = unlimited. */
  @Column({ type: 'integer', default: 1 })
  maxSessions!: number;
  @Column({ type: 'integer', default: 0 })
  maxChatbots!: number;
  @Column({ type: 'integer', default: 0 })
  maxWebhooks!: number;

  /** Monthly price in cents, 0 for free. Display-only: billing integration is out of scope. */
  @Column({ type: 'integer', default: 0 })
  priceCents!: number;

  /** Dashboard ordering. */
  @Column({ type: 'integer', default: 0 })
  sort!: number;

  /** Suspended plans refuse new subscriptions; existing accounts keep working. */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
