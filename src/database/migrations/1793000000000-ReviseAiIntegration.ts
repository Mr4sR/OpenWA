import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Integration revision 1, from operator feedback:
 *
 * - `ai_llm_models.persona` is dropped: the persona is a property of the CHATBOT (one place to
 *   edit it), not of the provider connection. The chatbot keeps its own `persona` column.
 * - `ai_chatbots.chatIds` / `cooldownSeconds` / `contextMessages` are dropped: the chat filter
 *   moves to a per-chat override table the Chats page writes (`ai_chat_overrides`), history size
 *   is fixed by the backend, and the loop guard is the same one the automation rules use
 *   (MAX_MESSAGE_AGE + never answer own messages) rather than an operator-tuned cooldown.
 * - `ai_chatbots.replyGroups` is added: the bot answers groups only when the operator opts in
 *   (a bot replying in a group speaks for the account in front of every member).
 * - `ai_rag_documents.status` is added: URL/site/file ingestion is asynchronous, so the row
 *   carries pending → processing → ready | failed for the dashboard to poll.
 * - `ai_mcp_connections.transport` is added: `streamable-http` (default) or `sse`, matching the
 *   two transports the MCP client SDK ships.
 */
export class ReviseAiIntegration1793000000000 implements MigrationInterface {
  name = 'ReviseAiIntegration1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const sqlite = !isPostgres;

    // ai_llm_models: drop persona.
    if (await queryRunner.hasColumn('ai_llm_models', 'persona')) {
      await queryRunner.query(`ALTER TABLE "ai_llm_models" DROP COLUMN "persona"`);
    }

    // ai_chatbots: drop the per-bot chat filter, cooldown and history size; add replyGroups.
    for (const col of ['chatIds', 'cooldownSeconds', 'contextMessages']) {
      if (await queryRunner.hasColumn('ai_chatbots', col)) {
        await queryRunner.query(`ALTER TABLE "ai_chatbots" DROP COLUMN "${col}"`);
      }
    }
    if (!(await queryRunner.hasColumn('ai_chatbots', 'replyGroups'))) {
      await queryRunner.query(
        `ALTER TABLE "ai_chatbots" ADD COLUMN "replyGroups" boolean NOT NULL DEFAULT ${isPostgres ? 'false' : '0'}`,
      );
    }

    // ai_chat_overrides: per-chat enable/disable, keyed (chatbotId, chatId).
    if (!(await queryRunner.hasTable('ai_chat_overrides'))) {
      await queryRunner.query(
        `CREATE TABLE "ai_chat_overrides" (` +
          `"id" varchar PRIMARY KEY NOT NULL${isPostgres ? ' DEFAULT gen_random_uuid()::varchar' : ''}, ` +
          `"chatbotId" varchar(36) NOT NULL, "chatId" varchar(255) NOT NULL, ` +
          `"chatbotDisabled" boolean NOT NULL DEFAULT ${isPostgres ? 'false' : '0'}, ` +
          `"createdAt" ${sqlite ? 'datetime' : 'timestamp'} NOT NULL DEFAULT ${sqlite ? "(datetime('now'))" : 'NOW()'}, ` +
          `"updatedAt" ${sqlite ? 'datetime' : 'timestamp'} NOT NULL DEFAULT ${sqlite ? "(datetime('now'))" : 'NOW()'}, ` +
          `CONSTRAINT "UQ_ai_chat_overrides_chatbot_chat" UNIQUE ("chatbotId", "chatId"), ` +
          `CONSTRAINT "FK_ai_chat_overrides_chatbot" FOREIGN KEY ("chatbotId") REFERENCES "ai_chatbots" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
      await queryRunner.query(`CREATE INDEX "IDX_ai_chat_overrides_chatbotId" ON "ai_chat_overrides" ("chatbotId")`);
    }

    // ai_rag_documents: ingestion status.
    if (!(await queryRunner.hasColumn('ai_rag_documents', 'status'))) {
      await queryRunner.query(
        `ALTER TABLE "ai_rag_documents" ADD COLUMN "status" varchar(12) NOT NULL DEFAULT 'ready'`,
      );
    }
    if (!(await queryRunner.hasColumn('ai_rag_documents', 'statusError'))) {
      await queryRunner.query(`ALTER TABLE "ai_rag_documents" ADD COLUMN "statusError" text`);
    }

    // ai_mcp_connections: transport kind.
    if (!(await queryRunner.hasColumn('ai_mcp_connections', 'transport'))) {
      await queryRunner.query(
        `ALTER TABLE "ai_mcp_connections" ADD COLUMN "transport" varchar(20) NOT NULL DEFAULT 'streamable-http'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('ai_mcp_connections', 'transport')) {
      await queryRunner.query(`ALTER TABLE "ai_mcp_connections" DROP COLUMN "transport"`);
    }
    if (await queryRunner.hasColumn('ai_rag_documents', 'statusError')) {
      await queryRunner.query(`ALTER TABLE "ai_rag_documents" DROP COLUMN "statusError"`);
    }
    if (await queryRunner.hasColumn('ai_rag_documents', 'status')) {
      await queryRunner.query(`ALTER TABLE "ai_rag_documents" DROP COLUMN "status"`);
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ai_chat_overrides_chatbotId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_chat_overrides"`);
    if (await queryRunner.hasColumn('ai_chatbots', 'replyGroups')) {
      await queryRunner.query(`ALTER TABLE "ai_chatbots" DROP COLUMN "replyGroups"`);
    }
    if (!(await queryRunner.hasColumn('ai_chatbots', 'contextMessages'))) {
      await queryRunner.query(`ALTER TABLE "ai_chatbots" ADD COLUMN "contextMessages" integer NOT NULL DEFAULT 8`);
    }
    if (!(await queryRunner.hasColumn('ai_chatbots', 'cooldownSeconds'))) {
      await queryRunner.query(`ALTER TABLE "ai_chatbots" ADD COLUMN "cooldownSeconds" integer NOT NULL DEFAULT 60`);
    }
    if (!(await queryRunner.hasColumn('ai_chatbots', 'chatIds'))) {
      await queryRunner.query(`ALTER TABLE "ai_chatbots" ADD COLUMN "chatIds" text`);
    }
    if (!(await queryRunner.hasColumn('ai_llm_models', 'persona'))) {
      await queryRunner.query(`ALTER TABLE "ai_llm_models" ADD COLUMN "persona" text`);
    }
  }
}
