import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `accounts` (the multi-tenant owner table) and binds API keys to one.
 *
 * `api_keys.accountId` is NULL for every existing row: NULL means the GLOBAL surface (the seeded
 * master key, and every key written before this feature), which keeps a single-tenant install
 * behaving exactly as before — a global key still reaches every session. Only a key created for an
 * account carries that account's id, and such a key is fenced to that account's sessions.
 *
 * No foreign key on purpose: `accounts.id` is a UUID and the key row must survive an account
 * deletion as a dead credential (it resolves to no account and is refused) rather than as a
 * cascaded delete of an audit-visible credential. Rows are small; the nullable index below is
 * partial so a single-tenant file costs nothing.
 *
 * Runs on the **main** connection (always SQLite). Idempotent: every step probes first, so a run
 * interrupted after the DDL still completes and a file built by `synchronize` is safe to adopt.
 */
export class AddAccounts1787500000000 implements MigrationInterface {
  name = 'AddAccounts1787500000000';

  private async tableExists(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'`,
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
    if (!(await this.tableExists(queryRunner))) {
      await queryRunner.query(
        `CREATE TABLE "accounts" (
          "id" varchar PRIMARY KEY NOT NULL,
          "name" varchar(80) NOT NULL,
          "note" varchar(500),
          "isActive" boolean NOT NULL DEFAULT (1),
          "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
          "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
        )`,
      );
      await queryRunner.query(`CREATE UNIQUE INDEX "UQ_accounts_name" ON "accounts" ("name")`);
    }

    if (!(await this.hasColumn(queryRunner, 'api_keys', 'accountId'))) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "accountId" varchar(36) NULL`);
    }
    if (!(await this.hasIndex(queryRunner, 'IDX_api_keys_accountId'))) {
      // Partial: only account-bound keys are ever looked up by account (the global rows stay NULL).
      await queryRunner.query(
        `CREATE INDEX "IDX_api_keys_accountId" ON "api_keys" ("accountId") WHERE "accountId" IS NOT NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasIndex(queryRunner, 'IDX_api_keys_accountId')) {
      await queryRunner.query(`DROP INDEX "IDX_api_keys_accountId"`);
    }
    if (await this.hasColumn(queryRunner, 'api_keys', 'accountId')) {
      // SQLite refuses DROP COLUMN on a column an index still references; the index is gone above.
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "accountId"`);
    }
    if (await this.tableExists(queryRunner)) {
      await queryRunner.query(`DROP TABLE "accounts"`);
    }
  }
}
