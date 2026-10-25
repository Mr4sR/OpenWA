import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Binds AI chatbots to the tenant that owns their session (multi-account SaaS).
 *
 * `ai_chatbots.sessionIds` is a JSON array of session ids; a bot serves one tenant because every
 * session belongs to exactly one account, so the owner is derived from the FIRST bound session and
 * copied once (the migration below backfills; the service keeps it in sync on create). NULL (every
 * existing row) keeps a pre-SaaS bot global — reachable by every key exactly as before. The
 * plan-limit counter for the `chatbots` kind reads this column.
 *
 * Idempotent like the rest: column + index probed before the DDL, both dialects shaped the same.
 */
export class AddChatbotAccount1800000000000 implements MigrationInterface {
  name = 'AddChatbotAccount1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    if (isPostgres) {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name='ai_chatbots' AND column_name='accountId'`,
      )) as unknown[];
      if (rows.length === 0) {
        await queryRunner.query(`ALTER TABLE "ai_chatbots" ADD COLUMN "accountId" varchar(36)`);
        await queryRunner.query(
          `UPDATE "ai_chatbots" SET "accountId" = (
             SELECT s."accountId" FROM "sessions" s
             WHERE "ai_chatbots"."sessionIds"::jsonb ->> 0 IS NOT NULL
               AND "ai_chatbots"."sessionIds"::jsonb ->> 0 = s."id"
           )`,
        );
      }
    } else {
      const rows = (await queryRunner.query(`PRAGMA table_info("ai_chatbots")`)) as Array<{ name: string }>;
      if (!rows.some(r => r.name === 'accountId')) {
        await queryRunner.query(`ALTER TABLE "ai_chatbots" ADD COLUMN "accountId" varchar(36)`);
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
    const indexRows = (await queryRunner.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='IDX_ai_chatbots_accountId'`,
    )) as Array<{ name: string }>;
    if (indexRows.length === 0) {
      await queryRunner.query(`CREATE INDEX "IDX_ai_chatbots_accountId" ON "ai_chatbots" ("accountId")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    if (isPostgres) {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name='ai_chatbots' AND column_name='accountId'`,
      )) as unknown[];
      if (rows.length > 0) {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ai_chatbots_accountId"`);
        await queryRunner.query(`ALTER TABLE "ai_chatbots" DROP COLUMN "accountId"`);
      }
      return;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("ai_chatbots")`)) as Array<{ name: string }>;
    if (rows.some(r => r.name === 'accountId')) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ai_chatbots_accountId"`);
      await queryRunner.query(`ALTER TABLE "ai_chatbots" DROP COLUMN "accountId"`);
    }
  }
}
