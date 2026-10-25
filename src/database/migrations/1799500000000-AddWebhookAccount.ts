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
 * Every probe (column AND index) is dialect-aware — this migration shipped with a bare
 * `sqlite_master` probe that broke every Postgres boot with `relation "sqlite_master" does not
 * exist`. Idempotent like the rest.
 */
export class AddWebhookAccount1799500000000 implements MigrationInterface {
  name = 'AddWebhookAccount1799500000000';

  private async columnExists(queryRunner: QueryRunner, table: string, column: string): Promise<boolean> {
    if (queryRunner.dataSource.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name = '${column}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === column);
  }

  private async indexExists(queryRunner: QueryRunner, name: string): Promise<boolean> {
    if (queryRunner.dataSource.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = '${name}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='${name}'`,
    )) as Array<{ name: string }>;
    return rows.length > 0;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    if (!(await this.columnExists(queryRunner, 'webhooks', 'accountId'))) {
      await queryRunner.query(`ALTER TABLE "webhooks" ADD COLUMN "accountId" varchar(36)`);
      // Backfill: a webhook inherits the account of the session it addresses.
      await queryRunner.query(
        `UPDATE "webhooks" SET "accountId" = (SELECT s."accountId" FROM "sessions" s WHERE s."id" = "webhooks"."sessionId")`,
      );
    }
    if (!(await this.indexExists(queryRunner, 'IDX_webhooks_accountId'))) {
      await queryRunner.query(`CREATE INDEX "IDX_webhooks_accountId" ON "webhooks" ("accountId")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.indexExists(queryRunner, 'IDX_webhooks_accountId')) {
      await queryRunner.query(`DROP INDEX "IDX_webhooks_accountId"`);
    }
    if (await this.columnExists(queryRunner, 'webhooks', 'accountId')) {
      await queryRunner.query(`ALTER TABLE "webhooks" DROP COLUMN "accountId"`);
    }
  }
}
