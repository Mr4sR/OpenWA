import { MigrationInterface, QueryRunner } from 'typeorm';

/** Backfill per stock slug; a slug added later keeps the column DEFAULT. */
const PLAN_ACTIVE_SESSION_DEFAULTS: Array<{ slug: string; max: number }> = [
  { slug: 'free', max: 1 },
  { slug: 'starter', max: 2 },
  { slug: 'pro', max: 5 },
  { slug: 'business', max: 10 },
];

/**
 * Adds `plans.maxConcurrentSessions` — the per-tenant RUNNING-session ceiling (READY /
 * INITIALIZING / QR_READY sessions of the account, enforced by PlanLimitsService kind
 * 'active_sessions' at SessionService.start()). `maxSessions` bounds how many session ROWS a plan
 * may own; this bounds how many of them may hold a live engine at once, so one tenant's burst
 * cannot crowd every other tenant out of a shared node and a plan's concurrency is real rather
 * than an artefact of the deployment-wide MAX_CONCURRENT_SESSIONS setting.
 *
 * The main connection is always SQLite (see AddSaasCore's header), so the probes are the same
 * `PRAGMA` style as the rest of this chain. The column is probed first, so an interrupted run never
 * double-applies; the backfill then sets each stock plan by slug (free 1, starter 2, pro 5,
 * business 10) and is idempotent by value, not only by probe.
 */
export class AddPlanMaxConcurrentSessions1800000000000 implements MigrationInterface {
  name = 'AddPlanMaxConcurrentSessions1800000000000';

  private async hasColumn(queryRunner: QueryRunner, table: string, name: string): Promise<boolean> {
    const rows = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'plans', 'maxConcurrentSessions'))) {
      // The DEFAULT is the Free-tier ceiling: a plan row created before this column existed starts
      // at the tightest value and is widened only by the backfill below or a platform-admin edit.
      await queryRunner.query(`ALTER TABLE "plans" ADD COLUMN "maxConcurrentSessions" integer NOT NULL DEFAULT 1`);
    }
    for (const { slug, max } of PLAN_ACTIVE_SESSION_DEFAULTS) {
      await queryRunner.query(`UPDATE "plans" SET "maxConcurrentSessions" = ? WHERE "slug" = ?`, [max, slug]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner, 'plans', 'maxConcurrentSessions')) {
      await queryRunner.query(`ALTER TABLE "plans" DROP COLUMN "maxConcurrentSessions"`);
    }
  }
}
