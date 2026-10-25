import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The SaaS layer: user logins (email + scrypt password), plans (tariffs), and the account↔plan
 * subscription. Everything runs on the **main** connection (auth), which is always SQLite.
 *
 * - `users` — email (unique, lowercased), scrypt password hash, role
 *   (`platform_admin` | `account_admin` | `account_member`), accountId (NULL = platform operator),
 *   isActive (a soft-disabled user cannot log in, its keys keep working until separately revoked).
 * - `plans` — the four stock tariffs seeded with sane limit defaults; platform admin may add more.
 *   FREE is the registration default and is never deletable (service-layer rule).
 * - `accounts` gains the subscription surface: planSlug (default 'free'), status
 *   ('active' | 'suspended' — suspended refuses login and its keys 401), planExpiresAt (a past
 *   expiry behaves like suspended), planStartedAt.
 * - `api_keys` gains userId — the login that minted the key (attribution only; enforcement stays
 *   on accountId).
 *
 * Idempotent like its siblings: every table/column probes before DDL, and the plan seed runs
 * inside `WHERE NOT EXISTS` so an interrupted run never double-inserts.
 */
export class AddSaasCore1799000000000 implements MigrationInterface {
  name = 'AddSaasCore1799000000000';

  private async hasTable(queryRunner: QueryRunner, name: string): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`,
    )) as Array<{ name: string }>;
    return rows.length > 0;
  }

  private async hasColumn(queryRunner: QueryRunner, table: string, name: string): Promise<boolean> {
    const rows = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  private async hasIndex(queryRunner: QueryRunner, name: string): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${name}'`,
    )) as Array<{ name: string }>;
    return rows.length > 0;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasTable(queryRunner, 'users'))) {
      await queryRunner.query(
        `CREATE TABLE "users" (
          "id" varchar PRIMARY KEY NOT NULL,
          "email" varchar(254) NOT NULL,
          "name" varchar(80) NOT NULL,
          "passwordHash" varchar(400) NOT NULL,
          "role" varchar(30) NOT NULL DEFAULT 'account_member',
          "accountId" varchar(36),
          "isActive" boolean NOT NULL DEFAULT (1),
          "lastLoginAt" datetime,
          "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
          "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
        )`,
      );
      await queryRunner.query(`CREATE UNIQUE INDEX "UQ_users_email" ON "users" ("email")`);
      await queryRunner.query(`CREATE INDEX "IDX_users_accountId" ON "users" ("accountId")`);
    }

    if (!(await this.hasTable(queryRunner, 'plans'))) {
      await queryRunner.query(
        `CREATE TABLE "plans" (
          "id" varchar PRIMARY KEY NOT NULL,
          "slug" varchar(30) NOT NULL,
          "name" varchar(60) NOT NULL,
          "maxSessions" integer NOT NULL DEFAULT 1,
          "maxChatbots" integer NOT NULL DEFAULT 0,
          "maxWebhooks" integer NOT NULL DEFAULT 0,
          "priceCents" integer NOT NULL DEFAULT 0,
          "sort" integer NOT NULL DEFAULT 0,
          "isActive" boolean NOT NULL DEFAULT (1),
          "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
          "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
        )`,
      );
      await queryRunner.query(`CREATE UNIQUE INDEX "UQ_plans_slug" ON "plans" ("slug")`);
    }

    // Stock tariffs — the registration default and the four upgrade steps. Idempotent seed.
    await queryRunner.query(
      `INSERT INTO "plans" ("id","slug","name","maxSessions","maxChatbots","maxWebhooks","priceCents","sort","isActive")
       SELECT lower(hex(randomblob(16))), 'free', 'Free', 1, 1, 1, 0, 0, 1
       WHERE NOT EXISTS (SELECT 1 FROM "plans" WHERE slug='free')`,
    );
    await queryRunner.query(
      `INSERT INTO "plans" ("id","slug","name","maxSessions","maxChatbots","maxWebhooks","priceCents","sort","isActive")
       SELECT lower(hex(randomblob(16))), 'starter', 'Starter', 3, 3, 5, 900, 1, 1
       WHERE NOT EXISTS (SELECT 1 FROM "plans" WHERE slug='starter')`,
    );
    await queryRunner.query(
      `INSERT INTO "plans" ("id","slug","name","maxSessions","maxChatbots","maxWebhooks","priceCents","sort","isActive")
       SELECT lower(hex(randomblob(16))), 'pro', 'Pro', 10, 10, 25, 2900, 2, 1
       WHERE NOT EXISTS (SELECT 1 FROM "plans" WHERE slug='pro')`,
    );
    await queryRunner.query(
      `INSERT INTO "plans" ("id","slug","name","maxSessions","maxChatbots","maxWebhooks","priceCents","sort","isActive")
       SELECT lower(hex(randomblob(16))), 'business', 'Business', 50, 50, 100, 9900, 3, 1
       WHERE NOT EXISTS (SELECT 1 FROM "plans" WHERE slug='business')`,
    );

    // Existing accounts become Free subscribers with no expiry.
    if (!(await this.hasColumn(queryRunner, 'accounts', 'planSlug'))) {
      await queryRunner.query(`ALTER TABLE "accounts" ADD COLUMN "planSlug" varchar(30) NOT NULL DEFAULT 'free'`);
    }
    if (!(await this.hasColumn(queryRunner, 'accounts', 'status'))) {
      await queryRunner.query(`ALTER TABLE "accounts" ADD COLUMN "status" varchar(20) NOT NULL DEFAULT 'active'`);
    }
    if (!(await this.hasColumn(queryRunner, 'accounts', 'planExpiresAt'))) {
      await queryRunner.query(`ALTER TABLE "accounts" ADD COLUMN "planExpiresAt" datetime`);
    }
    if (!(await this.hasColumn(queryRunner, 'accounts', 'planStartedAt'))) {
      await queryRunner.query(`ALTER TABLE "accounts" ADD COLUMN "planStartedAt" datetime`);
    }
    if (!(await this.hasIndex(queryRunner, 'IDX_accounts_planSlug'))) {
      await queryRunner.query(`CREATE INDEX "IDX_accounts_planSlug" ON "accounts" ("planSlug")`);
    }

    if (!(await this.hasColumn(queryRunner, 'api_keys', 'userId'))) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "userId" varchar(36)`);
    }
    if (!(await this.hasIndex(queryRunner, 'IDX_api_keys_userId'))) {
      await queryRunner.query(
        `CREATE INDEX "IDX_api_keys_userId" ON "api_keys" ("userId") WHERE "userId" IS NOT NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasIndex(queryRunner, 'IDX_api_keys_userId')) {
      await queryRunner.query(`DROP INDEX "IDX_api_keys_userId"`);
    }
    if (await this.hasColumn(queryRunner, 'api_keys', 'userId')) {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "userId"`);
    }
    if (await this.hasIndex(queryRunner, 'IDX_accounts_planSlug')) {
      await queryRunner.query(`DROP INDEX "IDX_accounts_planSlug"`);
    }
    for (const column of ['planStartedAt', 'planExpiresAt', 'status', 'planSlug']) {
      if (await this.hasColumn(queryRunner, 'accounts', column)) {
        await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "${column}"`);
      }
    }
    if (await this.hasTable(queryRunner, 'plans')) {
      await queryRunner.query(`DROP TABLE "plans"`);
    }
    if (await this.hasIndex(queryRunner, 'IDX_users_accountId')) {
      await queryRunner.query(`DROP INDEX "IDX_users_accountId"`);
    }
    if (await this.hasTable(queryRunner, 'users')) {
      await queryRunner.query(`DROP TABLE "users"`);
    }
  }
}
