import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the four tables of AI Integration:
 *
 * - `ai_llm_models` — LLM provider connections (endpoint, api key, sampling parameters, persona).
 * - `ai_chatbots` — one instance per (session, bot): LLM/RAG bindings, persona, chat allowlist.
 * - `ai_rag_models` / `ai_rag_documents` — vectorless (PageIndex-style) knowledge bases: the tree
 *   index lives as JSON on the model row; the documents table holds the raw knowledge entries.
 * - `ai_mcp_connections` — outbound MCP server connections (endpoint + optional credential).
 *
 * All reference sessions through varchar FKs that match `sessions.id` (the same convention as
 * `webhooks.sessionId`); a session deletion cascades. `ai_llm_models`, `ai_rag_models` and
 * `ai_mcp_connections` are account-wide (no session dimension), so nothing cascades into them.
 *
 * Hand-authored because `synchronize` is disabled for the `data` connection on PostgreSQL (and may
 * be disabled on SQLite via DATABASE_SYNCHRONIZE=false).
 */
export class AddAiIntegration1792000000000 implements MigrationInterface {
  name = 'AddAiIntegration1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const ts = isPostgres ? 'timestamp' : 'datetime';
    const now = isPostgres ? 'NOW()' : "(datetime('now'))";
    const boolTrue = isPostgres ? 'true' : '1';
    const uuidDefault = isPostgres ? ' DEFAULT gen_random_uuid()::varchar' : '';

    if (!(await queryRunner.hasTable('ai_llm_models'))) {
      await queryRunner.query(
        `CREATE TABLE "ai_llm_models" ("id" varchar PRIMARY KEY NOT NULL${uuidDefault}, ` +
          `"name" varchar(100) NOT NULL, "endpointUrl" varchar(2048) NOT NULL, "apiKey" varchar(512) NOT NULL DEFAULT '', ` +
          `"model" varchar(200) NOT NULL DEFAULT '', "persona" text, "parameters" text, "headers" text NOT NULL DEFAULT '{}', ` +
          `"enabled" boolean NOT NULL DEFAULT ${boolTrue}, "lastStatus" text, "lastTestedAt" ${ts}, ` +
          `"createdAt" ${ts} NOT NULL DEFAULT ${now}, "updatedAt" ${ts} NOT NULL DEFAULT ${now})`,
      );
      await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ai_llm_models_name" ON "ai_llm_models" ("name")`);
    }

    if (!(await queryRunner.hasTable('ai_chatbots'))) {
      // The FK DDL is identical on both dialects (SQLite accepts it inside CREATE TABLE).
      const fk =
        `, CONSTRAINT "FK_ai_chatbots_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION`;
      await queryRunner.query(
        `CREATE TABLE "ai_chatbots" ("id" varchar PRIMARY KEY NOT NULL${uuidDefault}, ` +
          `"sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "llmModelId" varchar(36) NOT NULL, ` +
          `"ragModelId" varchar(36), "persona" text, "chatIds" text, "cooldownSeconds" integer NOT NULL DEFAULT 60, ` +
          `"contextMessages" integer NOT NULL DEFAULT 8, "enabled" boolean NOT NULL DEFAULT ${boolTrue}, ` +
          `"lastRepliedAt" ${ts}, "lastError" text, "metadata" text, ` +
          `"createdAt" ${ts} NOT NULL DEFAULT ${now}, "updatedAt" ${ts} NOT NULL DEFAULT ${now}${fk})`,
      );
      await queryRunner.query(`CREATE INDEX "IDX_ai_chatbots_sessionId" ON "ai_chatbots" ("sessionId")`);
    }

    if (!(await queryRunner.hasTable('ai_rag_models'))) {
      await queryRunner.query(
        `CREATE TABLE "ai_rag_models" ("id" varchar PRIMARY KEY NOT NULL${uuidDefault}, ` +
          `"name" varchar(100) NOT NULL, "sessionScope" varchar(10) NOT NULL DEFAULT 'all', "sessionIds" text, ` +
          `"llmModelId" varchar(36), "enabled" boolean NOT NULL DEFAULT ${boolTrue}, ` +
          `"topK" integer NOT NULL DEFAULT 4, "maxContextChars" integer NOT NULL DEFAULT 4000, ` +
          `"index" text, "indexedAt" ${ts}, "lastIndexError" text, ` +
          `"createdAt" ${ts} NOT NULL DEFAULT ${now}, "updatedAt" ${ts} NOT NULL DEFAULT ${now})`,
      );
      await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ai_rag_models_name" ON "ai_rag_models" ("name")`);
    }

    if (!(await queryRunner.hasTable('ai_rag_documents'))) {
      await queryRunner.query(
        `CREATE TABLE "ai_rag_documents" ("id" varchar PRIMARY KEY NOT NULL${uuidDefault}, ` +
          `"ragModelId" varchar(36) NOT NULL, "sourceType" varchar(10) NOT NULL, "title" varchar(255), ` +
          `"sourceUrl" varchar(2048), "content" text, "storageKey" varchar(512), "metadata" text, ` +
          `"createdAt" ${ts} NOT NULL DEFAULT ${now}, "updatedAt" ${ts} NOT NULL DEFAULT ${now})`,
      );
      await queryRunner.query(`CREATE INDEX "IDX_ai_rag_documents_ragModelId" ON "ai_rag_documents" ("ragModelId")`);
    }

    if (!(await queryRunner.hasTable('ai_mcp_connections'))) {
      await queryRunner.query(
        `CREATE TABLE "ai_mcp_connections" ("id" varchar PRIMARY KEY NOT NULL${uuidDefault}, ` +
          `"name" varchar(100) NOT NULL, "endpointUrl" varchar(2048) NOT NULL, "authKind" varchar(10) NOT NULL DEFAULT 'none', ` +
          `"authHeader" varchar(100) NOT NULL DEFAULT 'X-API-Key', "authCredential" varchar(2048) NOT NULL DEFAULT '', ` +
          `"headers" text NOT NULL DEFAULT '{}', "timeoutMs" integer NOT NULL DEFAULT 30000, ` +
          `"enabled" boolean NOT NULL DEFAULT ${boolTrue}, "lastStatus" text, ` +
          `"createdAt" ${ts} NOT NULL DEFAULT ${now}, "updatedAt" ${ts} NOT NULL DEFAULT ${now})`,
      );
      await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ai_mcp_connections_name" ON "ai_mcp_connections" ("name")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB, where this migration was
    // recorded via the up() hasTable early-return and the named indexes were never created.
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_ai_mcp_connections_name"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_mcp_connections"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ai_rag_documents_ragModelId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_rag_documents"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_ai_rag_models_name"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_rag_models"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ai_chatbots_sessionId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_chatbots"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_ai_llm_models_name"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_llm_models"`);
  }
}
