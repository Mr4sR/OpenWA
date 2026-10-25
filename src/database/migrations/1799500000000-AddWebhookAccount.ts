import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Binds webhooks to the tenant that owns their session (multi-account SaaS).
 *
 * `webhooks.accountId` mirrors `sessions.accountId`: the webhook is addressed to a session, the
 * session belongs to one tenant, so the copy is written once at create time and never changes.
 * NULL (every existing row) keeps a pre-SaaS webhook global — reachable by every key, exactly as
 * before. The plan-limit counter for the `webhooks` kind reads this column, so the copy is what
 * makes quota enforcement possible at all.
 *
 * Idempotent like the rest: column + index probed before the DDL, both dialects shaped the same.
 */
export class AddWebhookAccount1799500000000 implements MigrationInterface {
  name = 'AddWebhookAccount1799500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    if (isPostgres) {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name='webhooks' AND column_name='accountId'`,
      )) as unknown[];
      if (rows.length === 0) {
        await queryRunner.query(`ALTER TABLE "webhooks" ADD COLUMN "accountId" varchar(36)`);
      }
    } else {
      const rows = (await queryRunner.query(`PRAGMA table_info("webhooks")`)) as Array<{ name: string }>;
      if (!rows.some(r => r.name === 'accountId')) {
        // SQLite cannot compute a value in ADD COLUMN; the backfill runs once after the column exists.
        await queryRunner.query(`ALTER TABLE "webhooks" ADD COLUMN "accountId" varchar(36)`);
        await queryRunner.query(
          `UPDATE "webhooks" SET "accountId" = (SELECT s."accountId" FROM "sessions" s WHERE s."id" = "webhooks"."sessionId")`,
        );
      }
    }
    const indexRows = (await queryRunner.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='IDX_webhooks_accountId'`,
    )) as Array<{ name: string }>;
    if (indexRows.length === 0) {
      await queryRunner.query(`CREATE INDEX "IDX_webhooks_accountId" ON "webhooks" ("accountId")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    if (isPostgres) {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name='webhooks' AND column_name='accountId'`,
      )) as unknown[];
      if (rows.length > 0) {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhooks_accountId"`);
        await queryRunner.query(`ALTER TABLE "webhooks" DROP COLUMN "accountId"`);
      }
      return;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("webhooks")`)) as Array<{ name: string }>;
    if (rows.some(r => r.name === 'accountId')) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhooks_accountId"`);
      await queryRunner.query(`ALTER TABLE "webhooks" DROP COLUMN "accountId"`);
    }
  }
}
