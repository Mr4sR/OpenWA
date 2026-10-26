import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Binds every AI surface to the tenant it belongs to (multi-account SaaS).
 *
 * Until this migration only `ai_chatbots` carried an owner, so a tenant key saw every other
 * tenant's LLM provider connections, RAG models and knowledge entries, MCP server connections and
 * per-chat switches. Each of those tables now gets the same `accountId varchar(36)` column, indexed
 * and NULL-able exactly like `ai_chatbots.accountId`:
 *
 *   - `ai_llm_models`, `ai_rag_models`, `ai_mcp_connections` are created BY a key, so the service
 *     stamps the caller's account. Rows that already exist cannot be attributed to anybody — a
 *     pre-SaaS install has one owner and every key is global — so they stay NULL, which means
 *     "global", reachable by a NULL-account (platform) key only. Same rule as the chatbot backfill.
 *   - `ai_rag_documents` inherits the account of its RAG model.
 *   - `ai_chat_overrides` inherits the account of its chatbot.
 *
 * Every probe (column AND index) is dialect-aware, and every backfill runs only when the column was
 * just added, so a second run is a no-op — same shape as AddChatbotAccount1800000000000.
 */
export class AddAiAccountScope1801000000000 implements MigrationInterface {
  name = 'AddAiAccountScope1801000000000';

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

  /** Add the column when missing, returning whether this run created it (the backfill's guard). */
  private async addAccountColumn(queryRunner: QueryRunner, table: string): Promise<boolean> {
    if (await this.columnExists(queryRunner, table, 'accountId')) return false;
    await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "accountId" varchar(36)`);
    return true;
  }

  private async addAccountIndex(queryRunner: QueryRunner, table: string): Promise<void> {
    const name = `IDX_${table}_accountId`;
    if (await this.indexExists(queryRunner, name)) return;
    await queryRunner.query(`CREATE INDEX "${name}" ON "${table}" ("accountId")`);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ownerless tables: a fresh column means no row can be attributed, so there is nothing to
    // backfill — existing rows stay NULL (global, platform-key reachable).
    for (const table of ['ai_llm_models', 'ai_rag_models', 'ai_mcp_connections']) {
      await this.addAccountColumn(queryRunner, table);
      await this.addAccountIndex(queryRunner, table);
    }

    // Knowledge entries inherit the owner of their RAG model (NULL parent keeps them global).
    if (await this.addAccountColumn(queryRunner, 'ai_rag_documents')) {
      await queryRunner.query(
        `UPDATE "ai_rag_documents" SET "accountId" = (
           SELECT m."accountId" FROM "ai_rag_models" m WHERE m."id" = "ai_rag_documents"."ragModelId"
         )`,
      );
    }
    await this.addAccountIndex(queryRunner, 'ai_rag_documents');

    // Per-chat switches inherit the owner of their chatbot (NULL parent keeps them global).
    if (await this.addAccountColumn(queryRunner, 'ai_chat_overrides')) {
      await queryRunner.query(
        `UPDATE "ai_chat_overrides" SET "accountId" = (
           SELECT b."accountId" FROM "ai_chatbots" b WHERE b."id" = "ai_chat_overrides"."chatbotId"
         )`,
      );
    }
    await this.addAccountIndex(queryRunner, 'ai_chat_overrides');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'ai_chat_overrides',
      'ai_rag_documents',
      'ai_mcp_connections',
      'ai_rag_models',
      'ai_llm_models',
    ]) {
      const name = `IDX_${table}_accountId`;
      if (await this.indexExists(queryRunner, name)) {
        await queryRunner.query(`DROP INDEX "${name}"`);
      }
      if (await this.columnExists(queryRunner, table, 'accountId')) {
        // SQLite refuses DROP COLUMN while an index references it; the index is gone above.
        await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "accountId"`);
      }
    }
  }
}
