import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Binds AI chatbots to the tenant that owns their session (multi-account SaaS).
 *
 * `ai_chatbots.sessionIds` is a JSON array of session ids; a bot serves one tenant because every
 * session belongs to exactly one account, so the owner is derived from the FIRST bound session and
 * copied once (the backfill below; the service keeps it in sync on create). NULL (every existing
 * row) keeps a pre-SaaS bot global — reachable by every key exactly as before. The plan-limit
 * counter for the `chatbots` kind reads this column.
 *
 * Every probe (column AND index) is dialect-aware — same fix as AddWebhookAccount1799500000000,
 * which shipped a bare `sqlite_master` probe that broke Postgres boots.
 */
export class AddChatbotAccount1800000000000 implements MigrationInterface {
  name = 'AddChatbotAccount1800000000000';

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
    if (!(await this.columnExists(queryRunner, 'ai_chatbots', 'accountId'))) {
      await queryRunner.query(`ALTER TABLE "ai_chatbots" ADD COLUMN "accountId" varchar(36)`);
      // Backfill: the bot inherits the account of its FIRST bound session. The column is the
      // simple-json text form, so the cast is on Postgres (`::jsonb`) and plain string matching
      // (`'["<id>"]'`) on SQLite, where json1 is not guaranteed.
      if (isPostgres) {
        await queryRunner.query(
          `UPDATE "ai_chatbots" SET "accountId" = (
             SELECT s."accountId" FROM "sessions" s
             WHERE "ai_chatbots"."sessionIds"::jsonb ->> 0 IS NOT NULL
               AND "ai_chatbots"."sessionIds"::jsonb ->> 0 = s."id"
           )`,
        );
      } else {
        await queryRunner.query(
          `UPDATE "ai_chatbots" SET "accountId" = (
             SELECT s."accountId" FROM "sessions" s
             WHERE "ai_chatbots"."sessionIds" IS NOT NULL
               AND "ai_chatbots"."sessionIds" != '[]'
               AND "ai_chatbots"."sessionIds" LIKE ('["' || s."id" || '"]')
           )`,
        );
      }
    }
    if (!(await this.indexExists(queryRunner, 'IDX_ai_chatbots_accountId'))) {
      await queryRunner.query(`CREATE INDEX "IDX_ai_chatbots_accountId" ON "ai_chatbots" ("accountId")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.indexExists(queryRunner, 'IDX_ai_chatbots_accountId')) {
      await queryRunner.query(`DROP INDEX "IDX_ai_chatbots_accountId"`);
    }
    if (await this.columnExists(queryRunner, 'ai_chatbots', 'accountId')) {
      await queryRunner.query(`ALTER TABLE "ai_chatbots" DROP COLUMN "accountId"`);
    }
  }
}
