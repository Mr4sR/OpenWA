import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Binds WhatsApp sessions to an account (tenant).
 *
 * `sessions.accountId` is NULL for every existing row: NULL means the GLOBAL surface — sessions
 * created before accounts existed, which every key may still reach. Only a session created by an
 * account-scoped key carries that key's accountId; keys of the same account (plus global keys) resolve it.
 * Both dialects store the same `varchar(36)` UUID-text column, so the shared entity keeps one
 * shape. Idempotent on both: the column is probed before the DDL.
 */
export class AddSessionAccount1797800000000 implements MigrationInterface {
  name = 'AddSessionAccount1797800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPg = queryRunner.connection.options.type === 'postgres';
    if (isPg) {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'sessions' AND column_name = 'accountId'`,
      )) as unknown[];
      if (rows.length === 0) {
        await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "accountId" varchar(36)`);
      }
    } else {
      const rows = (await queryRunner.query(`PRAGMA table_info("sessions")`)) as Array<{ name: string }>;
      if (!rows.some(r => r.name === 'accountId')) {
        await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "accountId" varchar(36)`);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPg = queryRunner.connection.options.type === 'postgres';
    if (isPg) {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'sessions' AND column_name = 'accountId'`,
      )) as unknown[];
      if (rows.length > 0) await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "accountId"`);
    } else {
      const rows = (await queryRunner.query(`PRAGMA table_info("sessions")`)) as Array<{ name: string }>;
      if (rows.some(r => r.name === 'accountId')) {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sessions_accountId"`);
        await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "accountId"`);
      }
    }
  }
}
