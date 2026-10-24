import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chatbot ⇄ session ownership becomes many-to-one: ONE chatbot may serve MANY sessions, and each
 * session is served by AT MOST ONE bot.
 *
 * `ai_chatbots` carries a FOREIGN KEY on `sessionId`, and SQLite refuses `DROP COLUMN` while any
 * constraint still names the column. The dependency graph makes a plain rebuild unsafe: DROP TABLE
 * on a parent whose child (`ai_chat_overrides`) still declares the FK trips SQLite's constraint
 * checker (it resolves the child's reference mid-rebuild and fails on the already-dropped
 * `sessions`). So the children are parked first:
 *
 *   1. copy `ai_chat_overrides` into a staging table,
 *   2. drop the child TABLE (dropping its FK with it),
 *   3. rebuild `ai_chatbots` in the new shape (`sessionIds` JSON array, one row per bot),
 *   4. recreate `ai_chat_overrides` with its FK pointed at the new `ai_chatbots`,
 *   5. restore the staged rows.
 *
 * Every existing bot keeps its single session (`[row.sessionId]`). FK pragma is toggled around the
 * work as well, so the rebuild never depends on the enforcement mode the host booted with.
 */
export class ChatbotMultiSession1795000000000 implements MigrationInterface {
  name = 'ChatbotMultiSession1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('ai_chatbots', 'sessionIds')) return;

    const hadOverrides = await queryRunner.hasTable('ai_chat_overrides');
    await queryRunner.query('PRAGMA foreign_keys = OFF');
    try {
      if (hadOverrides) {
        await queryRunner.query(`CREATE TABLE "ai_chat_overrides_stage" AS SELECT * FROM "ai_chat_overrides"`);
        await queryRunner.query(`DROP TABLE "ai_chat_overrides"`);
      }

      await queryRunner.query(
        `CREATE TABLE "ai_chatbots_new" (` +
          `"id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionIds" text NOT NULL DEFAULT '[]', ` +
          `"name" varchar(100) NOT NULL, ` +
          `"llmModelId" varchar(36) NOT NULL, ` +
          `"ragModelId" varchar(36), ` +
          `"persona" text, ` +
          `"mcpToolIds" text, ` +
          `"replyGroups" boolean NOT NULL DEFAULT 0, ` +
          `"enabled" boolean NOT NULL DEFAULT 1, ` +
          `"lastRepliedAt" datetime, ` +
          `"lastError" text, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
          `)`,
      );
      // '[' + '"' + id + '"' + ']' by concatenation: JSON1's JSON_ARRAY is not on every build.
      await queryRunner.query(
        `INSERT INTO "ai_chatbots_new" ` +
          `("id", "sessionIds", name, "llmModelId", "ragModelId", persona, "mcpToolIds", "replyGroups", enabled, "lastRepliedAt", "lastError", "createdAt", "updatedAt") ` +
          `SELECT id, '[' || CHAR(34) || "sessionId" || CHAR(34) || ']', name, "llmModelId", "ragModelId", persona, "mcpToolIds", "replyGroups", enabled, "lastRepliedAt", "lastError", "createdAt", "updatedAt" FROM "ai_chatbots"`,
      );
      await queryRunner.query(`DROP TABLE "ai_chatbots"`);
      await queryRunner.query(`ALTER TABLE "ai_chatbots_new" RENAME TO "ai_chatbots"`);
      await queryRunner.query(`CREATE INDEX "IDX_ai_chatbots_sessionIds" ON "ai_chatbots" ("sessionIds")`);

      if (hadOverrides) {
        await queryRunner.query(
          `CREATE TABLE "ai_chat_overrides" (` +
            `"id" varchar PRIMARY KEY NOT NULL, ` +
            `"chatbotId" varchar(36) NOT NULL, ` +
            `"chatId" varchar(255) NOT NULL, ` +
            `"chatbotDisabled" boolean NOT NULL DEFAULT 0, ` +
            `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
            `"updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
            `CONSTRAINT "UQ_ai_chat_overrides_chatbot_chat" UNIQUE ("chatbotId", "chatId"), ` +
            `CONSTRAINT "FK_ai_chat_overrides_chatbot" FOREIGN KEY ("chatbotId") REFERENCES "ai_chatbots" ("id") ON DELETE CASCADE ON UPDATE NO ACTION` +
            `)`,
        );
        await queryRunner.query(
          `INSERT INTO "ai_chat_overrides" ("id", "chatbotId", "chatId", "chatbotDisabled", "createdAt", "updatedAt") ` +
            `SELECT "id", "chatbotId", "chatId", "chatbotDisabled", "createdAt", "updatedAt" FROM "ai_chat_overrides_stage"`,
        );
        await queryRunner.query(`DROP TABLE "ai_chat_overrides_stage"`);
        await queryRunner.query(`CREATE INDEX "IDX_ai_chat_overrides_chatbotId" ON "ai_chat_overrides" ("chatbotId")`);
      }
    } finally {
      await queryRunner.query('PRAGMA foreign_keys = ON');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('ai_chatbots', 'sessionId')) return;

    const hadOverrides = await queryRunner.hasTable('ai_chat_overrides');
    await queryRunner.query('PRAGMA foreign_keys = OFF');
    try {
      if (hadOverrides) {
        await queryRunner.query(`CREATE TABLE "ai_chat_overrides_stage" AS SELECT * FROM "ai_chat_overrides"`);
        await queryRunner.query(`DROP TABLE "ai_chat_overrides"`);
      }

      await queryRunner.query(
        `CREATE TABLE "ai_chatbots_old" (` +
          `"id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar NOT NULL, ` +
          `"name" varchar(100) NOT NULL, ` +
          `"llmModelId" varchar(36) NOT NULL, ` +
          `"ragModelId" varchar(36), ` +
          `"persona" text, ` +
          `"mcpToolIds" text, ` +
          `"replyGroups" boolean NOT NULL DEFAULT 0, ` +
          `"enabled" boolean NOT NULL DEFAULT 1, ` +
          `"lastRepliedAt" datetime, ` +
          `"lastError" text, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
          `)`,
      );
      // Keep the FIRST session of each bot (string surgery: JSON1 may be unavailable).
      await queryRunner.query(
        `INSERT INTO "ai_chatbots_old" ` +
          `("id", "sessionId", name, "llmModelId", "ragModelId", persona, "mcpToolIds", "replyGroups", enabled, "lastRepliedAt", "lastError", "createdAt", "updatedAt") ` +
          `SELECT id, REPLACE(REPLACE(RTRIM("sessionIds", ']'), '[', ''), CHAR(34), ''), name, "llmModelId", "ragModelId", persona, "mcpToolIds", "replyGroups", enabled, "lastRepliedAt", "lastError", "createdAt", "updatedAt" FROM "ai_chatbots"`,
      );
      await queryRunner.query(`DROP TABLE "ai_chatbots"`);
      await queryRunner.query(`ALTER TABLE "ai_chatbots_old" RENAME TO "ai_chatbots"`);
      await queryRunner.query(`CREATE INDEX "IDX_ai_chatbots_sessionId" ON "ai_chatbots" ("sessionId")`);

      if (hadOverrides) {
        await queryRunner.query(
          `CREATE TABLE "ai_chat_overrides" (` +
            `"id" varchar PRIMARY KEY NOT NULL, ` +
            `"chatbotId" varchar(36) NOT NULL, ` +
            `"chatId" varchar(255) NOT NULL, ` +
            `"chatbotDisabled" boolean NOT NULL DEFAULT 0, ` +
            `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
            `"updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
            `CONSTRAINT "UQ_ai_chat_overrides_chatbot_chat" UNIQUE ("chatbotId", "chatId"), ` +
            `CONSTRAINT "FK_ai_chat_overrides_chatbot" FOREIGN KEY ("chatbotId") REFERENCES "ai_chatbots" ("id") ON DELETE CASCADE ON UPDATE NO ACTION` +
            `)`,
        );
        await queryRunner.query(
          `INSERT INTO "ai_chat_overrides" ("id", "chatbotId", "chatId", "chatbotDisabled", "createdAt", "updatedAt") ` +
            `SELECT "id", "chatbotId", "chatId", "chatbotDisabled", "createdAt", "updatedAt" FROM "ai_chat_overrides_stage"`,
        );
        await queryRunner.query(`DROP TABLE "ai_chat_overrides_stage"`);
        await queryRunner.query(`CREATE INDEX "IDX_ai_chat_overrides_chatbotId" ON "ai_chat_overrides" ("chatbotId")`);
      }
    } finally {
      await queryRunner.query('PRAGMA foreign_keys = ON');
    }
  }
}
